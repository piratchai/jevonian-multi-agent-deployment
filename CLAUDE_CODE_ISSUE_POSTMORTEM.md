# Claude Code & Jevonian Multi-Agent Integration Postmortem

This document details the issues, root causes, diagnostic methods, and verified fixes identified while deploying **Jevonian** as a local model router for **Claude Code** (both CLI and VS Code GUI) and configuring 6 local MCP servers (`serena`, `codebase-memory`, `lsp`, `memora`, `sequentialthinking`, `spotlight`).

---

## 1. Issue: Anthropic 400 Bad Request on Sonnet 5.5 (`"thinking.type.disabled" is not supported for this model`)

### Symptoms
When Claude Code requested the `jevonian/auto` model for utility, background, or chit-chat tiers with effort `"none"`, the gateway logged an HTTP 400 rejection from Anthropic:
```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "\"thinking.type.disabled\" is not supported for this model. Use \"thinking.type.between_tools\" for the lowest thinking setting, or \"thinking.type.adaptive\" and \"output_config.effort\" to control thinking behavior."
  },
  "request_id": "req_011CfWzHwpr8r6DSsCTZfvi9"
}
```

### Root Cause
Anthropic updated its model behavior for newer models (such as `claude-opus-5-5` and `claude-sonnet-5-5`) to mandate **always-on thinking**. These models strictly reject `"thinking": { "type": "disabled" }`.
Upstream Jevonian's [`src/anthropic-thinking.ts`](file:///D:/work/sourcecode/workflow_reimbursement/jevonian-multi-agent-deployment/jevonian/src/anthropic-thinking.ts) only checked:
```typescript
rejectsDisabled: (family === "opus" && version >= 5.5) || version >= 6
```
Because `family === "sonnet"`, `rejectsDisabled` evaluated to `false`. When the routing tier specified `effort: "none"`, Jevonian sent `{ type: "disabled" }`, causing Anthropic to return 400 Bad Request.

### Solution & Fix
Updated [`src/anthropic-thinking.ts`](file:///D:/work/sourcecode/workflow_reimbursement/jevonian-multi-agent-deployment/jevonian/src/anthropic-thinking.ts) to flag both `opus` and `sonnet` 5.5+ as rejecting disabled thinking:
```typescript
rejectsDisabled: ((family === "opus" || family === "sonnet") && version >= 5.5) || version >= 6
```
With this fix, whenever effort is `"none"` or minimal on Sonnet 5.5, Jevonian automatically emits `{ type: "adaptive" }` with `output_config.effort: "low"`, which passes Anthropic validation.

---

## 2. Issue: VS Code Brown Banner: "Settings file failed to parse"

### Symptoms
In the VS Code Claude extension panel, a prominent brown banner appeared:
```text
Settings file failed to parse: d:\work\sourcecode\workflow_hbt\.claude\settings.json — Expected string, but received undefined. Permission rules and other settings from this file are not in effect.
```
Claude Code discarded the local `.claude/settings.json`, ignored `ANTHROPIC_BASE_URL: "http://127.0.0.1:8792"`, and fell back to the global default model (`Sonnet 5 Medium`).

### Root Cause
According to Claude Code's settings schema (`claude-code-settings.schema.json`), `modelOverrides` is defined strictly as:
```json
"modelOverrides": {
  "type": "object",
  "additionalProperties": { "type": "string" }
}
```
An object `{ "jevonian/auto": { "behavesAs": "claude-3-7-sonnet-20250219" } }` had been written into `modelOverrides`. Zod schema validation expected a string value and threw `Expected string, but received undefined`.

### Solution & Fix
1. Removed `modelOverrides` from project `.claude/settings.json`.
2. `behavesAs` belongs to `modelPicker.options` in the **global user settings** (`%USERPROFILE%\.claude\settings.json`). Configured `modelPicker` in user settings:
   ```json
   "modelPicker": {
     "options": [
       {
         "model": "jevonian/auto",
         "label": "Jevonian Auto",
         "description": "Local intelligent model router (Sonnet 5.5)",
         "behavesAs": "claude-sonnet-5-5"
       }
     ],
     "replaceBuiltInOptions": false
   }
   ```
3. This eliminated the parse error and made **`Jevonian Auto`** appear in the VS Code model dropdown.

---

## 3. Issue: Compact Thrashing & Repetitive "Have you done?" Prompts

### Symptoms
1. The message banner:
   ```text
   Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row. A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or use /clear to start fresh.
   ```
2. Claude constantly forgot recent actions and asked repeatedly: *"Have you done? / What would you like to work on?"*.

### Root Cause
1. **Third-Party Plugin `claude-mem@thedotmack`**: On every compaction or session start, `claude-mem`'s `SessionStart:compact` hook dumped 15+ observation tables (over 85,000 tokens) into the context.
2. **Reading Massive Files**: Claude was reading large files like `PreCheckForm.svelte` (3,890 lines / ~60k tokens) into the prompt.
3. **Small Default Window**: Claude Code assumed a 200,000-token window ceiling for custom models.
With 85k tokens from `claude-mem` + 60k tokens from file reading, the 200k window was breached in 1-2 turns, triggering an endless loop of compacting and memory loss.

### Solution & Fix
1. **Disabled `claude-mem` in Project Settings**:
   ```json
   "enabledPlugins": {
     "claude-mem@thedotmack": false
   }
   ```
2. **Expanded Context Window to 800,000 Tokens**:
   ```json
   {
     "autoCompactWindow": 800000,
     "env": {
       "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "800000"
     }
   }
   ```
3. **Leveraged Dedicated MCP Servers**:
   - `memora` & `codebase-memory`: Clean, on-demand memory tools that only retrieve data when specifically invoked, without polluting every turn.
   - `serena` & `lsp`: Used for targeted AST symbol queries rather than dumping 3,890-line files.
4. **Session Reset**: Instructed the user to use `/clear` when beginning a new task to purge old execution transcripts.

---

## 4. Issue: Playwright Headful Browser Invisible on Desktop

### Symptoms
Claude reported: *"The app is up and loaded in the Playwright browser at http://localhost:3422/"*, but no visible browser window appeared on the desktop screen. Calling Playwright MCP again threw:
```text
Error: Browser is already in use for ...\ms-playwright-mcp\mcp-chrome-4246e4d, use --isolated to run multiple instances of the same browser
```

### Root Cause
Playwright MCP server runs Chrome using `--remote-debugging-pipe` as a background child process (`MainWindowHandle: 0`). It communicates via CDP pipes for programmatic DOM evaluation and automated screenshots rather than opening a desktop window. If the process is left running, the user-data directory stays locked.

### Solution & Fix
1. To view the running application as a human user, use Windows `start`:
   ```cmd
   start http://localhost:3422/
   ```
2. To release an orphaned profile lock:
   ```cmd
   taskkill /F /PID <stuck_chrome_pid> /T
   ```

---

## 5. Multi-Project Port Isolation

To run multiple workspaces concurrently without interference:

| Workspace | Gateway Port | Public API | Jevonian Dir | Config Path |
|---|---|---|---|---|
| **workflow_reimbursement** | `8790` | `8791` | `workflow_reimbursement/jevonian-multi-agent-deployment` | `~/.config/jevonian-claude/config.json` |
| **workflow_hbt** | `8792` | `8793` | `workflow_hbt/jevonian-multi-agent-deployment` | `~/.config/jevonian-hbt/config.json` |

---

## 6. Installed MCP Servers Summary

Both `workflow_reimbursement` and `workflow_hbt` are equipped with 6 verified MCP servers:
- **`serena`**: Semantic code retrieval & refactoring IDE in local `.venv` (30 tools).
- **`codebase-memory`**: High-performance native binary code memory (16 tools).
- **`lsp`**: Local Node Language Server Protocol for TypeScript & Python (33 tools).
- **`memora`**: SQLite semantic memory backend in `.venv` (42 tools).
- **`sequentialthinking`**: Dynamic multi-step reasoning tool.
- **`spotlight`**: Sidecar debugging server (Port 8969 for reimbursement, Port 8970 for HBT).
