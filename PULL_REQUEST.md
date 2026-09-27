# Pull Request: Multi-Agent Support for OpenCode & Claude Code (Wire Normalizer + Tier Effort Routing)

**Target Repository:** [`xinyao27/jevonian`](https://github.com/xinyao27/jevonian)  
**Base Branch:** `main`  
**Feature Branch:** `feat/opencode-wire-and-effort-routing`  
**Related Deployments & Tools:** OpenCode CLI (`@ai-sdk/openai-compatible`), Claude Code (`@anthropic-ai/claude-code`), Alibaba Cloud Model Studio (Bailian Token Plan), Anthropic API.  

---

## 📌 Executive Summary

This Pull Request resolves critical runtime incompatibilities when using **Jevonian** as a local router for modern AI coding agents—specifically **OpenCode** and **Claude Code**:

1. **OpenCode Wire Normalizer (`normalizeOpenAIMessages`)**: Fixes fatal `400 Bad Request` crashes when OpenCode talks to strict OpenAI-compatible upstreams (e.g. Alibaba Cloud Model Studio / Bailian MaaS) caused by Anthropic-style blocks (`type: "tool_use"`, `type: "tool_result"`) stored inside multi-turn `message.content` arrays.
2. **Phase-Level Reasoning Effort Routing**: Adds explicit `effort` configuration (`low`, `medium`, `high`, `xhigh`) to routing tiers (`chat`, `utility`, `execute`, `plan`), allowing users and agent orchestrators to enforce reasoning budgets per task difficulty.
3. **Comprehensive Unit Test Coverage**: Adds test suites in `src/wire-correction.test.ts` covering all wire translation and sanitization edge cases.

---

## 🔍 The Problem & What Was Missing in Upstream Jevonian

### Problem 1: OpenCode Tool Execution Failure (`if content is list. item must be dict and key[type] should in dict`)
- **What happened:** When running multi-turn coding sessions with tool execution in OpenCode, upstream providers like Alibaba Cloud Model Studio rejected requests with:
  ```json
  {"error":{"code":"invalid_parameter_error","message":"if content is list. item must be dict and key[type] should in dict","type":"invalid_request_error"}}
  ```
- **Why upstream Jevonian missed this:** Upstream Jevonian only translated payloads when bridging across different protocols (e.g. Anthropic to OpenAI or Responses to OpenAI). However, when OpenCode calls `/v1/chat/completions` (OpenAI wire) and routes to an OpenAI-compatible upstream, Jevonian treated the request as `native` (`bridge: "none"`).
- **The underlying conflict:** OpenCode's `@ai-sdk/openai-compatible` client retains prior tool interactions in its session history using Anthropic content blocks:
  - Assistant turn: `content: [{ type: "text", text: "..." }, { type: "tool_use", id: "...", name: "...", input: {...} }]`
  - User turn: `content: [{ type: "tool_result", tool_use_id: "...", content: "..." }]`
  Strict Python validators on upstreams like Alibaba Cloud reject any `content` array where items are not `{ type: "text" }` or `{ type: "image_url" }`.

### Problem 2: Missing Effort Configuration per Routing Tier
- **What happened:** Upstream Jevonian only allowed reasoning effort to be set globally or inferred dynamically by the routing brain. Users could not pin specific effort levels to specific routing tiers (e.g., forcing `low` effort on `chat`, `medium` on `execute`, and `xhigh` on `plan`).
- **Why this was needed:** Different coding phases have drastically different reasoning requirements:
  - `chat`: Greetings & clarification queries need fast, low-effort responses.
  - `utility`: File indexing and summaries need fast execution without deep reasoning overhead.
  - `execute`: Coding and test execution require medium reasoning effort.
  - `plan`: High-level architecture, design blueprints, and deep debugging require high/extra-high reasoning budgets.

---

## 🛠️ Detailed Changes & Enhancements

### 1. `src/wire.ts` — Added `normalizeOpenAIMessages()`
A robust, lossless normalizer for outbound OpenAI wire messages:
- **Assistant `tool_use` to OpenAI `tool_calls`**:
  Converts `{ type: "tool_use", id, name, input }` blocks embedded in `content` into standard OpenAI `tool_calls: [{ id, type: "function", function: { name, arguments } }]`.
- **User `tool_result` to OpenAI `role: "tool"`**:
  Converts `{ type: "tool_result", tool_use_id, content }` blocks into independent `{ role: "tool", tool_call_id, content }` messages.
- **Flattens Text Arrays**:
  Combines plain text array items into single newline-separated strings (`textParts.join("\n")`), satisfying strict upstream schema checkers.
- **Multimodal Preservation**:
  Preserves `{ type: "image_url", ... }` objects intact for multimodal vision tools and emulator screenshots.
- **Null Safety**:
  Sets `assistant.content = null` when only `tool_calls` are present, conforming strictly to the OpenAI specification.

### 2. `src/upstream.ts` — Egress Pipeline Integration
- Injected `normalizeOpenAIMessages()` into the egress pipeline before sending requests upstream:
  ```typescript
  if (upstreamKind === "openai" && Array.isArray(upstreamBody.messages)) {
    upstreamBody.messages = normalizeOpenAIMessages(
      upstreamBody.messages as Record<string, unknown>[],
    );
  }
  ```
- Also applied normalization to `chatToGemini` when bridging OpenAI client requests to Gemini envelopes.

### 3. `src/config.ts` — Added `effort` to `RoutingEntry`
- Extended the `RoutingEntry` interface:
  ```typescript
  export interface RoutingEntry {
    id: string;
    label: string;
    description?: string;
    models: ModelEntry[];
    providers?: Record<string, string[]>;
    effort?: ReasoningEffort; // Added: "low" | "medium" | "high" | "xhigh"
  }
  ```
- Updated `parseRoutingEntry` to validate and extract `effort` safely using `isReasoningEffort()`.

### 4. `src/routing.ts` — Tier Effort Decision Logic
- Updated `decideRoute()`:
  ```typescript
  const tierEffort = routings.find((entry) => entry.id === phase)?.effort;
  const wanted = tierEffort ?? (brainPicksEffort ? brainEffort(best?.verdict.effort) : undefined);
  ```
- Generates transparent log metadata (`tier set "${tierEffort}"`) so developers can audit which tier dictated the reasoning level.

### 5. `src/wire-correction.test.ts` — Unit Test Suite
Added 5 comprehensive unit tests:
1. `leaves standard string messages untouched`
2. `joins text arrays into a single string for strict OpenAI backends`
3. `translates assistant tool_use blocks to OpenAI tool_calls`
4. `translates user tool_result blocks to OpenAI role: tool messages`
5. `preserves multimodal image_url content items`

---

## 📊 Summary of Modified Files

```
 src/config.ts              |  10 +++++--
 src/routing.ts             |   8 +++--
 src/upstream.ts            |  16 +++++++-
 src/wire.ts                | 148 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 src/wire-correction.test.ts| 104 +++++++++++++++++++++++++++++++++++++++++++++
 5 files changed, 280 insertions(+), 6 deletions(-)
```

---

## 🧪 Verification & Reproduction Evidence

### 1. Reproduction with Exact Failed Payload
- Captured Turn: `05a8ca6c-b5c8-4461-9bcd-398c54eda2a9.json` (50 messages from a real OpenCode Android/Flutter session).
- **Before Fix:** Alibaba Cloud Model Studio returned:
  `400 Bad Request: if content is list. item must be dict and key[type] should in dict`
- **After Fix:** Jevonian normalized the 50 messages on the fly.
  Alibaba Cloud returned: **`200 OK`** and streamed **148 chunks** successfully.

### 2. Unit Tests
Executed via `npx vp test src/wire-correction.test.ts`:
```text
✓ src/wire-correction.test.ts (8 tests) 49ms
Test Files  1 passed (1)
Tests       8 passed (8)
```

### 3. Live Gateway Verification (`test-verify.js`)
Probed both local gateways:
- OpenCode Gateway on Port `8787`: `HTTP 200 OK` (tool wire normalizer verified live).
- Claude Code Gateway on Port `8790`: `HTTP 200 OK` (Anthropic wire and effort routing verified live).

---

## 💡 Multi-Agent Deployment Assets (Reference)

For reference, the operational runners, configs, and troubleshooting post-mortem developed alongside this patch are documented in [`jevonian-multi-agent-deployment`](https://github.com/piratchai/jevonian-multi-agent-deployment):
- `OPENCODE_ISSUE_POSTMORTEM.md`: In-depth breakdown of the OpenCode wire bug.
- `run-opencode.js` / `run-opencode.bat`: Gateway launcher for Port 8787.
- `run-claude.js` / `run-claude.bat`: Gateway launcher for Port 8790.
- `test-verify.js`: Automated probe script for CI/CD and local diagnostics.
