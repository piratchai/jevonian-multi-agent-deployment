# OpenCode Wire Format Issue & Technical Post-Mortem

**Document Version:** 1.0.0  
**Target Environment:** OpenCode CLI + Jevonian Gateway (Port 8787)  
**Upstream Provider:** Alibaba Cloud Model Studio (Token Plan / Bailian MaaS)  
**Related Screenshot:** `C:\Users\pirat\Pictures\screenshots\screenshot_2026-09-27-11-29-26-647.png`  
**Failed Turn ID:** `05a8ca6c-b5c8-4461-9bcd-398c54eda2a9` (from `~/.local/share/jevonian/ledger.jsonl`)

---

## 1. Incident Overview

While running a complex task in `D:\learn\gemini-mcp\gemini-blogdee-subdomain` using **OpenCode**, the user encountered an immediate terminal failure during tool execution:

```text
Bad Request: data: {
  "error": {
    "code": "invalid_parameter_error",
    "param": null,
    "message": "if content is list. item must be dict and key[type] should in dict",
    "type": "invalid_request_error"
  },
  "id": "chatcmpl-3756b878-5575-4f5d-9c0c-769a1d8600ec"
}
```

The error completely halted the OpenCode session and prevented the agent from continuing its workflow.

---

## 2. Root Cause Analysis

### 2.1 OpenCode Internal Representation
OpenCode (built upon the Vercel AI SDK / `@ai-sdk/openai-compatible`) maintains multi-turn conversation states internally using Anthropic-compatible message parts.

When tools are executed in a session:
1. **The Assistant Response** records both text thinking and tool invocations as content blocks:
   ```json
   {
     "role": "assistant",
     "content": [
       { "type": "text", "text": "Checking application base URL..." },
       {
         "type": "tool_use",
         "id": "call_2bfaf17dc70343daad3ec23c",
         "name": "autonews_read_file",
         "input": { "path": "lib/core/app_config.dart" }
       }
     ]
   }
   ```
2. **The User Response** sends the tool results back as content blocks:
   ```json
   {
     "role": "user",
     "content": [
       {
         "type": "tool_result",
         "tool_use_id": "call_2bfaf17dc70343daad3ec23c",
         "content": "{\"status\":\"ok\"}"
       }
     ]
   }
   ```

When `@ai-sdk/openai-compatible` forwards this history to an OpenAI-compatible endpoint (`/v1/chat/completions`), it simply serializes `message.content` as an array without converting Anthropic blocks into OpenAI-native fields.

### 2.2 Upstream Strictness: Alibaba Cloud Model Studio
Unlike lenient proxies that silently drop unknown content fields, Alibaba Cloud Model Studio (`dashscope-intl.aliyuncs.com` / `token-plan.ap-southeast-1.maas.aliyuncs.com`) executes strict schema validation on the incoming OpenAI request:

```python
# Alibaba Cloud backend validator pseudo-code:
if isinstance(content, list):
    for item in content:
        if not isinstance(item, dict) or 'type' not in item or item['type'] not in ['text', 'image_url']:
            raise InvalidParameterError("if content is list. item must be dict and key[type] should in dict")
```

When Alibaba Cloud inspected Message 16 (`type: "tool_use"`) and Message 17 (`type: "tool_result"`), it rejected the request with `invalid_parameter_error`.

---

## 3. The Technical Solution

Rather than hacking OpenCode's client library or restricting MCP tools, we implemented a gateway-level normalizer: **`normalizeOpenAIMessages()`**.

### 3.1 Architecture of the Normalizer
Location: [`src/wire.ts`](file:///D:/learn/gemini-mcp/gemini-blogdee-subdomain/jevonian/src/wire.ts)  
Invoked in: [`src/upstream.ts`](file:///D:/learn/gemini-mcp/gemini-blogdee-subdomain/jevonian/src/upstream.ts)

Before any payload is dispatched upstream to an OpenAI-wire provider (`upstreamKind === "openai"` or `geminiWire`), Jevonian inspects all messages:

1. **Assistant Messages with `tool_use`**:
   - Gathers all `type: "text"` parts into a standard string: `assistant.content = textParts.join("\n")`.
   - Extracts all `type: "tool_use"` blocks into standard OpenAI `tool_calls`:
     ```json
     {
       "tool_calls": [
         {
           "id": "call_2bfaf17dc70343daad3ec23c",
           "type": "function",
           "function": {
             "name": "autonews_read_file",
             "arguments": "{\"path\":\"lib/core/app_config.dart\"}"
           }
         }
       ]
     }
     ```
   - If no text exists, sets `content: null` (standard OpenAI convention for tool call turns).

2. **User Messages with `tool_result`**:
   - Converts each `type: "tool_result"` block into a dedicated OpenAI tool message:
     ```json
     {
       "role": "tool",
       "tool_call_id": "call_2bfaf17dc70343daad3ec23c",
       "content": "..."
     }
     ```
   - Emits any accompanying user text as an independent preceding user turn.

3. **Plain Text Arrays**:
   - If `content` is an array of text strings (e.g. `["part 1", "part 2"]` or `[{ type: "text", text: "..." }]`), it is merged with `\n` into a single string.

4. **Multimodal Preservation**:
   - `{ type: "image_url", ... }` objects remain intact so emulator screenshots and image inputs work seamlessly.

---

## 4. Code Implementation

### In `src/wire.ts`:
```typescript
export function normalizeOpenAIMessages(
  messages: Array<Record<string, unknown>> | unknown[],
): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) return [];
  const out: Array<Record<string, unknown>> = [];

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const msg = { ...(raw as Record<string, unknown>) };
    const role = msg.role;

    if (!Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }

    const textParts: string[] = [];
    const imageParts: Array<Record<string, unknown>> = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    const toolResults: Array<Record<string, unknown>> = [];

    for (const item of msg.content) {
      if (!item) continue;
      if (typeof item === "string") {
        textParts.push(item);
        continue;
      }
      if (typeof item !== "object") {
        textParts.push(String(item));
        continue;
      }

      const rec = item as Record<string, unknown>;
      const type = rec.type;
      if (type === "text") {
        if (typeof rec.text === "string") textParts.push(rec.text);
      } else if (type === "image_url" || type === "input_audio") {
        imageParts.push(rec);
      } else if (type === "tool_use") {
        let args = "{}";
        if (typeof rec.input === "string") {
          args = rec.input;
        } else if (rec.input !== undefined && rec.input !== null) {
          args = JSON.stringify(rec.input);
        }
        toolCalls.push({
          id: rec.id || `call_${Math.random().toString(36).slice(2, 10)}`,
          type: "function",
          function: {
            name: rec.name || "",
            arguments: args,
          },
        });
      } else if (type === "tool_result") {
        let contentStr = "";
        if (typeof rec.content === "string") {
          contentStr = rec.content;
        } else if (Array.isArray(rec.content)) {
          contentStr = rec.content
            .map((c) =>
              typeof c === "string"
                ? c
                : (c as Record<string, unknown>).text || JSON.stringify(c),
            )
            .join("\n");
        } else if (rec.content !== undefined && rec.content !== null) {
          contentStr = JSON.stringify(rec.content);
        }
        toolResults.push({
          role: "tool",
          tool_call_id: rec.tool_use_id || rec.id || "",
          content: contentStr,
        });
      } else if (typeof rec.text === "string") {
        textParts.push(rec.text);
      } else {
        textParts.push(JSON.stringify(rec));
      }
    }

    if (role === "assistant") {
      const assistantMsg: Record<string, unknown> = {
        ...msg,
        role: "assistant",
        content:
          textParts.length > 0
            ? textParts.join("\n")
            : imageParts.length > 0
              ? imageParts
              : toolCalls.length > 0 || msg.tool_calls
                ? null
                : "",
      };
      if (toolCalls.length > 0) {
        const existing = Array.isArray(msg.tool_calls) ? (msg.tool_calls as unknown[]) : [];
        assistantMsg.tool_calls = [...existing, ...toolCalls];
      }
      out.push(assistantMsg);
    } else if (role === "user") {
      if (textParts.length > 0 || imageParts.length > 0) {
        if (imageParts.length > 0) {
          out.push({
            ...msg,
            role: "user",
            content: [
              ...textParts.map((t) => ({ type: "text", text: t })),
              ...imageParts,
            ],
          });
        } else {
          out.push({
            ...msg,
            role: "user",
            content: textParts.join("\n"),
          });
        }
      }
      for (const tr of toolResults) {
        out.push(tr);
      }
    } else {
      out.push({
        ...msg,
        content:
          textParts.length > 0
            ? textParts.join("\n")
            : imageParts.length > 0
              ? imageParts
              : "",
      });
    }
  }

  return out;
}
```

### In `src/upstream.ts`:
```typescript
    let upstreamBody: Record<string, unknown> = bodyFor(upstreamKind);
    if (upstreamKind === "responses") {
      upstreamBody = ensureResponsesCallIds(upstreamBody);
    }
    // OpenAI Chat Completions sanitizer
    if (upstreamKind === "openai" && Array.isArray(upstreamBody.messages)) {
      upstreamBody.messages = normalizeOpenAIMessages(
        upstreamBody.messages as Record<string, unknown>[],
      );
    }
```

---

## 5. Verification Results

| Test Scenario | Payload Source | Result |
|---|---|---|
| Direct Upstream with Malformed Turn | `05a8ca6c-b5c8-4461-9bcd-398c54eda2a9.json` | `400 Bad Request` (reproduced) |
| Through Jevonian Port 8787 | `05a8ca6c-b5c8-4461-9bcd-398c54eda2a9.json` | **`200 OK` (148 chunks streamed)** |
| Unit Test Suite | `src/wire-correction.test.ts` (8 test cases) | **8 passed, 0 failed** |
| Automated Health Probe | `test-verify.js` | **`SUCCESS! Routed to: qwen3.7-plus`** |

---

## 6. How to Reapply After Updating Jevonian

If you pull updates from upstream `jevonian` in the future:
```powershell
cd D:\learn\gemini-mcp\gemini-blogdee-subdomain\jevonian
git apply ..\jevonian-multi-agent-deployment\patch-jevonian.diff
pnpm build
```
This restores the normalizer and effort-routing enhancements immediately.
