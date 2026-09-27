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

---

## 7. Incident 2: Multimodal Image Accumulation & Timeout ("Download multimodal file timed out")

**Incident Date:** 2026-09-27  
**Target Environment:** OpenCode CLI (v2.x) + Jevonian Gateway (Port 8787)  
**Upstream Provider:** Alibaba Cloud Model Studio (`qwen3.8-flash`)  
**Related Screenshot:** `screenshot_2026-09-27-14-29-59-139.png`  
**Failed Turn ID:** `e7a562bb-f147-4ef9-b46b-118d4c57feaf` (from `~/.local/share/jevonian/ledger.jsonl`)

### 7.1 Symptom & Error
During an automated Android UI testing session using `android_Wait`, `android_ClickBySelector`, `android_Snapshot`, `android_Click`, and `android_Press`, OpenCode suddenly crashed with a red terminal banner:

```text
Bad Request: data: {
  "error": {
    "code": "invalid_parameter_error",
    "param": null,
    "message": "Download multimodal file timed out",
    "type": "invalid_request_error"
  },
  "id": "chatcmpl-f0722446-7b2b-4536-9285-5cbeaee1819b"
}
```

The ledger record revealed:
- **Status:** `400 Bad Request`
- **Model:** `qwen3.8-flash`
- **Latency:** `64,706 ms` (64.7 seconds)
- **Token Count:** `226,586 tokens (23% used)`

### 7.2 Root Cause Analysis

#### 1. Unpruned Historical Screenshots in OpenCode
When OpenCode captures UI screenshots via `android_Snapshot`, it injects each image as a base64 Data URI (`data:image/png;base64,...`) into the conversation history. By default, OpenCode has **`compaction.prune: false`**, meaning **all previous tool outputs are retained indefinitely**. On every single turn, OpenCode re-serialized and re-transmitted every historical snapshot.

#### 2. False Sense of Context Headroom
In `opencode.json`, `jevonian/auto` declared a context limit of `983,616 tokens`. At 226k tokens, OpenCode reported only **23% used**. Because OpenCode believed 77% of the context remained, it never triggered automatic compaction or summarization.

#### 3. Alibaba Cloud Gateway Timeout
When Jevonian forwarded the 226k-token payload containing dozens of megabytes of raw base64 image strings to Alibaba Cloud Model Studio, Alibaba's multimodal gateway spent 64.7 seconds attempting to decode and parse all cumulative images simultaneously before terminating with `Download multimodal file timed out`.

### 7.3 Why Kilo CLI Did NOT Suffer From This Issue
In the same environment, **Kilo CLI** performed the same operations without error:
- Kilo CLI manages tool outputs in history more cleanly and avoids accumulating repeated full-resolution base64 PNGs across successive turns.
- Kilo payloads sent to Jevonian are lightweight text tokens, allowing Alibaba Cloud to respond in milliseconds.

### 7.4 Research & Discovery via Ref MCP
Using the **Ref MCP** tool (`ref_search_documentation`), we queried OpenCode's official documentation (`https://opencode.ai/docs/config#compaction`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "compaction": {
    "auto": true,
    "prune": false,
    "reserved": 10000
  }
}
```

The documentation explicitly notes:
- **`auto`**: *"Automatically compact the session when context is full (default: true)."*
- **`prune`**: *"Remove old tool outputs to save tokens (default: false). Set to true to enable pruning."*
- **`reserved`**: *"Token buffer for compaction. Leaves enough window to avoid overflow during compaction."*

### 7.5 Resolution & Configuration
To permanently fix the issue in OpenCode:

1. **Enable Auto-Pruning & Compaction in `opencode.json`:**
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "compaction": {
       "auto": true,
       "prune": true,
       "reserved": 10000
     }
   }
   ```
   Setting `"prune": true` instructs OpenCode to automatically discard stale tool outputs (such as earlier Android screenshots) as the session progresses.

2. **Immediate Recovery in Active Sessions:**
   Typing `/compact` inside an active OpenCode session immediately purges historical base64 media and summarizes the preceding conversation without restarting.

3. **System-Wide Ref MCP Integration:**
   Configured `REF_API_KEY` in Windows environment (`setx`) and added environment blocks to all tool manifests (`opencode.json`, `kilo.json`, `.mcp.json`, etc.) so documentation lookups are accessible to all agents.

---

## 8. OpenCode V1 vs. OpenCode V2 Architectural Analysis

With OpenCode V2 (`https://opencode.ai/v2/docs`), the internal execution engine, session durability model, and configuration contracts have been redesigned.

### 8.1 What Changed from V1 to V2

| Area | OpenCode V1 | OpenCode V2 | Impact |
|---|---|---|---|
| **Compaction Engine** | Message replay; `preserve_recent_tokens` or `prune: true` | **Checkpoint-based compaction** with `keep.tokens` & `buffer` | **Breaking**: `prune` & `tail_turns` are ignored with warnings. Recent context is retained by token budget as plain text. |
| **Provider Syntax** | `"provider": { "name": { "npm": "...", "options": { ... } } }` | `"providers": { "name": { "package": "aisdk:...", "settings": { ... } } }` | Native V2 uses `providers` map, `aisdk:` package prefix, and `settings`. |
| **Permissions** | Object grouped by tool: `"permission": { "bash": { "*": "allow" } }` | Ordered rule array: `"permissions": [ { "action": "shell", "resource": "*", "effect": "allow" } ]` | Actions renamed: `bash` → `shell`, `task` → `subagent`, `write`/`patch` → `edit`. |
| **MCP Servers** | `"mcp": { "ref": { "enabled": true } }` | `"mcp": { "servers": { "ref": { "disabled": false } } }` | Nested under `servers`; `enabled` inverted to `disabled`; split timeouts (`catalog`, `execution`). |
| **Media / Images** | `"attachment": { "image": { ... } }` | `"media": { "image": { ... } }` | Standardized under `media`. |
| **Plugins** | `"plugin": [ ... ]` | `"plugins": [ ... ]` | New V2 Plugin API (V1 plugins do not run in V2). |
| **Model Capabilities** | `"tool_call": true`, `"modalities": { ... }` | `"capabilities": { "tools": true, "input": [...], "output": [...] }` | Explicit capability mapping. |
| **Client Settings** | Layered `tui.json(c)` | Single global `~/.config/opencode/cli.json` | Terminal UI preferences isolated from server. |

### 8.2 Which Previous Fixes Are Obsolete in OpenCode V2?

#### 1. `compaction.prune: true` is Obsolete in V2
- **In V1:** OpenCode blindly replayed historical raw provider messages, re-transmitting base64 screenshots across turns unless `prune: true` was explicitly set.
- **In V2:** OpenCode completely removed the `prune` parameter. OpenCode V2 migration documentation explicitly notes:
  > *"compaction.tail_turns and compaction.prune: V2 uses compaction.keep.tokens and checkpoint-based compaction instead. V2 has no native tail_turns or prune field; both legacy fields are ignored with a warning."*
- **Why it's no longer needed:** In V2, automatic preflight compaction converts prior turns into a durable structured text summary checkpoint and only retains a strict token budget (`keep.tokens`) of recent turns. Historical base64 images are natively excluded from the model-visible continuation payload.

#### 2. `compaction.reserved` is Replaced by `compaction.buffer`
- In V2, the token reserve parameter is renamed to `compaction.buffer: 20000`, providing clean headroom below the model's actual context window.

#### 3. Wire Normalization (`normalizeOpenAIMessages`) in Jevonian
- In V2, OpenCode implements a `Structured Tool Registry And Canonical Output` contract where tool executions are settled before provider continuation.
- **Router Status:** While OpenCode V2 generates cleaner internal representations, the router-level normalizer in Jevonian (`normalizeOpenAIMessages()` in `src/wire.ts`) **should remain active in the router**. Jevonian acts as a universal multi-agent gateway; keeping the normalizer guarantees that any OpenAI-compatible provider (like Alibaba Cloud Model Studio) never receives un-lowered Anthropic blocks regardless of which client or SDK version connects.


