# Pull Request: Multi-Agent Support for OpenCode (v1 & v2) & Claude Code — Wire Normalization, Multimodal Timeout Prevention, and Tier Effort Routing

- **Target Repository:** [`xinyao27/jevonian`](https://github.com/xinyao27/jevonian)
- **Base Branch:** `main` (fully rebased on upstream **`v0.3.2`**)
- **Feature Branch:** `feat/opencode-wire-and-effort-routing`
- **Related Agents & Upstreams:** OpenCode CLI (v1 & v2), Claude Code, Alibaba Cloud Model Studio (DashScope / Bailian Qwen), DeepSeek, Anthropic API.

---

## 📌 Executive Summary

This Pull Request provides end-to-end multi-agent compatibility for **OpenCode (v1 and v2)** and **Claude Code** through the local Jevonian router. It eliminates severe upstream runtime crashes, resolves multimodal gateway timeouts, and ensures proper effort steering across all supported backends.

All commits are cleanly rebased on the latest **upstream `v0.3.2`** (`ffa55f1`), fully integrating with upstream's prompt policy rewriting (`rewritePromptBodies`) and brain benchmark slimming.

---

## 🔍 Root Cause Analysis: Dashboard "Status" Column Errors (`400` & `499`)

When inspecting the Jevonian local dashboard (`/logs`), long multi-turn sessions with visual inspection (e.g. Android emulator, Flutter, Playwright UI testing) consistently displayed two critical failures in the **Status** column:

### 1. Status `400 Bad Request` (`Download multimodal file timed out`)
- **Observed Symptoms:** After turn ~20–30, requests to multimodal models (such as `qwen3.8-flash` on Alibaba Cloud DashScope) hung for **62.5 seconds** before failing with:
  ```json
  {
    "error": {
      "code": "invalid_parameter_error",
      "message": "Download multimodal file timed out",
      "type": "invalid_request_error"
    }
  }
  ```
- **Root Cause:**
  1. **OpenCode Client Behavior:** OpenCode retains the full conversation history. In sessions involving screenshots, OpenCode re-sends *all previous base64 images* across every turn. By turn 40–80, the request payload contains multiple large base64 screenshots (over **1.5 MB of base64 text / 320,000+ expected tokens**).
  2. **Upstream Gateway Limit:** Gateways like Alibaba Cloud Model Studio enforce a strict internal **60-second multimodal file ingestion/decoding timeout**. Decoding multiple stale base64 images from 50–100 turns ago exceeds 60s, causing DashScope to abort with HTTP 400.

### 2. Status `499 Client Closed Request` (`client canceled`)
- **Observed Symptoms:** Followed immediately after the 400 error, where the latency registered **88,330 ms** and **20,692 ms** with `"client canceled"`.
- **Root Cause:** OpenCode (or the user) waited 60–90 seconds for a response from the stalled multimodal download, hit its client timeout, and terminated the TCP connection.

---

## 🛠️ Itemized Breakdown of Architectural Fixes

### Item 1: Two-Pass Multimodal Screenshot Pruning (`src/wire.ts`)
- **Problem:** Unbounded base64 screenshot accumulation in multi-turn agent sessions triggers upstream 60s multimodal timeouts.
- **Fix:** In `normalizeOpenAIMessages()`:
  - Scans total multimodal image items across the conversation history.
  - **Preserves the 2 most recent images** for active tool execution, visual verification, and side-by-side comparisons.
  - Automatically substitutes older historical screenshots from previous turns with a lightweight placeholder string:
    ```json
    { "type": "text", "text": "[Previous screenshot omitted to prevent multimodal timeout]" }
    ```
- **Impact:** Outbound payload size drops by **>90%** (saving ~1.38 MB of base64 text per request), reducing upstream multimodal decode latency from **62.5s down to <500ms**.

### Item 2: Comprehensive Anthropic Image Source Conversion (`src/wire.ts`)
- **Problem:** When Anthropic-style payloads are bridged to OpenAI wire, image blocks with `source: { type: "base64" }` or `source: { type: "url" }` failed schema validation on OpenAI backends.
- **Fix:** Added complete source conversion:
  - Base64 sources convert to standard `data:${mediaType};base64,${data}` URIs.
  - URL sources (`source: { type: "url", url: "..." }`) convert to standard OpenAI `image_url: { url: "..." }` parts (addressing CodeRabbit review feedback).

### Item 3: OpenAI Wire Normalizer for Tool Calls & Content Blocks (`src/wire.ts`)
- **Problem:** OpenCode embeds Anthropic-style blocks (`type: "tool_use"`, `type: "tool_result"`) inside `content` arrays. Strict backends (Alibaba Qwen, DeepSeek) reject these with:
  `"if content is list. item must be dict and key[type] should in dict"`
- **Fix:**
  - Extracts `tool_use` blocks into standard OpenAI `tool_calls` on assistant messages.
  - Translates `tool_result` blocks into standard `role: "tool"` messages with `tool_call_id`.
  - Merges plain text arrays into unified strings for strict OpenAI-compatible schema compliance.

### Item 4: Base64 Token Normalization in Compaction (`src/compaction.ts`)
- **Problem:** Compaction token estimation uses naive character length (`chars / 4`). A single 1 MB base64 screenshot was estimated as ~250,000 tokens, falsely triggering premature context compaction or throwing calculation errors.
- **Fix:** Replaced base64 data URLs in `estimateTokens()` with standard visual token weights (~1,600 tokens/image) and sanitized compaction history.

### Item 5: Effort Routing Normalization (`src/upstream.ts`)
- **Problem:** OpenCode (v1 & v2) specifies effort as `low`, `medium`, `high`, `xhigh` or `none`. Upstream reasoning models require strict mapping (`reasoning_effort` for OpenAI/DeepSeek vs `thinking.budget_tokens` for Anthropic).
- **Fix:** Implemented unified effort mapping and clean pass-through for all reasoning tiers.

### Item 6: Full Compatibility with Upstream `v0.3.2`
- Cleanly rebased onto upstream `v0.3.2` (`ffa55f1`).
- Merged upstream's `rewritePromptBodies()` alongside `normalizeOpenAIMessages()` in `src/upstream.ts`.
- Preserved `jevoKey` recognition and brain benchmark token slimming.

---

## 🧪 Verification & Test Suite

- **Unit Tests:** All **11/11 tests pass** in [`src/wire-correction.test.ts`](file:///D:/learn/gemini-mcp/gemini-blogdee-subdomain/jevonian/src/wire-correction.test.ts) covering tool normalization, text joining, multimodal pruning, base64 conversion, and URL image sources.
- **Wire Tests:** All **16/16 tests pass** in `src/wire.test.ts`.
- **E2E Validation:** Verified against live OpenCode Flutter/Android and web sessions through Alibaba Cloud DashScope (`qwen3.8-flash`). Multimodal decode latency verified at **<500ms** with zero 400/499 errors.
