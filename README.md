# Jevonian Dual-Agent Routing Setup Guide (OpenCode & Claude Code)

This guide documents the complete end-to-end architecture, installation, code patching, and configuration required to run **Jevonian** as a local intelligent model router for both **OpenCode** and **Claude Code** simultaneously.

---

> [!IMPORTANT]
> ## 🚀 Quick-Start Checklist & Chronological Runbook
> Follow these steps in order before launching any CLI clients:
> 
> 1. **Sanitize Windows Environment (Critical First Step)**:
>    Check if Windows CMD has legacy `AutoRun` hooks or hijacked `doskey` macros that intercept `claude`:
>    ```powershell
>    # Check if AutoRun hook exists
>    reg query "HKCU\Software\Microsoft\Command Processor" /v AutoRun
>    # If found, delete it permanently:
>    reg delete "HKCU\Software\Microsoft\Command Processor" /v AutoRun /f
>    # Flush active macro in currently open CMD windows:
>    doskey claude=
>    ```
> 2. **Build & Patch Upstream Jevonian**:
>    Clone `https://github.com/xinyao27/jevonian.git`, apply `patch-jevonian.diff`, and compile:
>    ```powershell
>    git clone https://github.com/xinyao27/jevonian.git ../jevonian
>    cd ../jevonian
>    git apply ../jevonian-multi-agent-deployment/patch-jevonian.diff
>    pnpm install
>    pnpm build
>    ```
> 3. **Configure Jevonian Instance (`~/.config/jevonian-claude/config.json`)**:
>    Copy `config-claudecode.json` to `~/.config/jevonian-claude/config.json`.
>    Ensure `"forceEffort": true` is set on every tier so Claude Code cannot override effort to `high`.
> 4. **Start the Background Gateway**:
>    ```powershell
>    # In jevonian-multi-agent-deployment directory:
>    node run-claude.js
>    # Or double-click: run-claude.bat
>    ```
>    Verify that it displays: `jevonian listening on http://127.0.0.1:8790/`.
> 5. **Scope Claude Code Locally (Do NOT Put in Global Settings)**:
>    In your project's `.claude/settings.json` (e.g. `workflow_reimbursement/.claude/settings.json`), set:
>    ```json
>    {
>      "model": "jevonian/auto",
>      "env": {
>        "ANTHROPIC_BASE_URL": "http://127.0.0.1:8790",
>        "ANTHROPIC_AUTH_TOKEN": "jevonian-local",
>        "ANTHROPIC_API_KEY": "",
>        "ANTHROPIC_DEFAULT_OPUS_MODEL": "jevonian/auto",
>        "ANTHROPIC_DEFAULT_SONNET_MODEL": "jevonian/auto",
>        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "jevonian/utility",
>        "CLAUDE_CODE_SUBAGENT_MODEL": "jevonian/auto"
>      }
>    }
>    ```
>    *Never put these environment variables into `~/.claude/settings.json` (global), or `jevonian/auto` will hijack every other folder on your machine!*
> 6. **Launch Claude Code**:
>    ```powershell
>    claude --dangerously-skip-permissions
>    ```

---

## 🧭 "If You Encounter This, Do This" — Rapid Diagnostic Decision Tree

If you encounter unexpected behavior during setup or runtime, consult this matrix immediately:

| # | Symptom / Error | Root Cause | Exact Fix ("Do This") |
|---|---|---|---|
| **1** | **Microsoft Edge opens automatically** or CMD displays `jevonian update` banner on running `claude` | Windows registry `AutoRun` is executing an obsolete DOSKEY macro from `D:\learn\JevAI` on every CMD startup. | 1. Run: `reg delete "HKCU\Software\Microsoft\Command Processor" /v AutoRun /f`<br/>2. In existing CMD windows run: `doskey claude=`<br/>3. Open a fresh terminal. |
| **2** | **Every model in Jevonian dashboard shows `effort: high`** (or `xhigh`), ignoring `low` / `medium` tier settings | 1. Claude Code CLI v2.1.282+ injects `"output_config": { "effort": "high" }` on every turn.<br/>2. Upstream Jevonian default rule is "client-specified effort wins over tier effort".<br/>3. Local `.claude/settings.json` might have `"effortLevel": "high"`. | 1. Add `"forceEffort": true` to every tier in `config.json`.<br/>2. Remove `"effortLevel": "high"` from your project `.claude/settings.json`.<br/>3. Restart the gateway. |
| **3** | **Rapid token filling & compaction:** `Compacting conversation... (1m 5s · ↓ 3.8k tokens) 0% until auto-compact` | 1. Claude Code enforces a **strict 200,000-token context ceiling** for unrecognized models like `jevonian/auto`.<br/>2. Bulk-reading large directories (e.g. `sessions/` = 10 MB = 2.6M tokens) or dumping entire MCP memory graphs (`read_graph`) overflows the window in one turn.<br/>3. Compaction cannot delete immediate turn tool outputs, leaving 0% headroom. | 1. **Never bulk-dump large folders** into Claude prompts.<br/>2. Use targeted file queries or grep/search tools.<br/>3. Use `search_nodes` instead of `read_graph`.<br/>4. Optionally add `"CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000"` to settings. |
| **4** | **`jevonian/auto` appears in other folders** where you wanted standard Anthropic Claude | `ANTHROPIC_BASE_URL` or `"model": "jevonian/auto"` was placed into global `~/.claude/settings.json`. | 1. Remove `model` and `env` from `C:\Users\<user>\.claude\settings.json`.<br/>2. Place `model` and `env` **only** inside `<project>/.claude/settings.json`. |
| **5** | **`Connection refused` (ECONNREFUSED) to `http://127.0.0.1:8790`** | The Jevonian background gateway is not running. Claude Code is a client and does not auto-spawn the server. | Double-click `run-claude.bat` or run `node run-claude.js` before launching `claude`. |
| **6** | **Running multiple projects simultaneously causes port conflicts** | Two gateways cannot bind to the same port (e.g. 8790). | Assign a unique port per workspace (e.g. `8790` for Reimbursement, `8792` for HBT). Each workspace gets its own config (`~/.config/jevonian-<name>/config.json`) and data directory. |
| **7** | **TypeSafe brain fails to activate** (falls back to heuristic routing) | `TYPESAFE_API_KEY` was not found in environment or credential paths. | Place key in `D:/work/sourcecode/workflow_reimbursement/config/typesafe-credential.txt` or set `TYPESAFE_API_KEY` environment variable. |
| **8** | **OpenCode fails with:** `if content is list. item must be dict and key[type] should in dict` | OpenCode leaves `tool_use`/`tool_result` inside `content` arrays for OpenAI-compatible providers. | Built-in normalizer (`patch-jevonian.diff`) normalizes wire format in `src/upstream.ts`. Apply `patch-jevonian.diff` and run `pnpm build`. |

---

## 1. System Architecture Overview

```mermaid
flowchart TD
    subgraph Clients["Terminal CLI Clients"]
        OC["OpenCode CLI<br/>(opencode)"]
        CC["Claude Code CLI<br/>(claude)"]
    end

    subgraph JevonianInstances["Local Jevonian Gateways"]
        JEV_OC["Jevonian Instance 1<br/>Port: 8787<br/>Config: ~/.config/jevonian/"]
        JEV_CC["Jevonian Instance 2<br/>Port: 8790<br/>Config: ~/.config/jevonian-claude/"]
    end

    subgraph UpstreamProviders["AI Model Providers"]
        P_API["API-Key Provider<br/>(OpenAI-Compatible / Any Provider)<br/>Models: Flash, Plus, Max"]
        P_CLAUDE["Anthropic Claude Official<br/>(OAuth via Claude Max/Pro Subscription)<br/>Models: Haiku 4.5, Sonnet 5, Opus 5.5"]
    end

    OC -->|http://127.0.0.1:8787/v1| JEV_OC
    CC -->|http://127.0.0.1:8790| JEV_CC

    JEV_OC -->|API Key + ChatCompletions Wire| P_API
    JEV_CC -->|OAuth Token + Messages API Wire| P_CLAUDE
```

### Why Run Two Ports?
- **Port 8787 (OpenCode)**: Configured for API-key providers using Chat Completions wire protocol.
- **Port 8790 (Claude Code)**: Configured for Anthropic official Claude models using Messages API wire protocol with OAuth subscription authentication.
- **Isolation**: Each service maintains its own session stores, prompt caching statistics, cost ledger, and browser dashboard.

---

## 2. Step 1: Pulling, Building & Patching Jevonian from GitHub

### 2.1 Clone and Check Updates
Clone the official Jevonian repository from GitHub:
```powershell
git clone https://github.com/xinyao27/jevonian.git
cd jevonian
```

To update an existing installation to the latest upstream release:
```powershell
git fetch origin
git pull origin main
```

### 2.2 Install Dependencies
Jevonian uses `pnpm`:
```powershell
pnpm install
```

---

### 2.3 The 36-Line Compatibility Patch (`patch-jevonian.diff`)
Out-of-the-box Jevonian has two limitations when used with modern Claude Code CLI and custom effort levels:
1. **Explicit Tier Effort**: By default, Jevonian lets the router brain guess effort dynamically. If you want hardcoded per-tier efforts (e.g., `chat: low`, `execute: medium`, `plan: xhigh`), the schema needs an `effort` field in `RoutingEntry`.
2. **Claude Code CLI & Haiku 4.5 Compatibility**: Modern Claude Code CLI (v2.1.282+) sends `context_management`, `adaptive thinking`, and mid-conversation `role: "system"` messages. While `sonnet-5` and `opus-5-5` accept these, `haiku-4-5` returns `400 Bad Request`. The patch transparently cleans these fields when routing to Haiku.

Apply the included patch file:
```powershell
git apply patch-jevonian.diff
```

#### What the Patch Changes:
- **`src/config.ts` (8 lines)**: Adds `effort?: ReasoningEffort` to `RoutingEntry` interface and parses `routings[i].effort` from `config.json`.
- **`src/routing.ts` (11 lines)**: Uses the tier's configured effort (`tierEffort`) when defined instead of defaulting to brain guesses.
- **`src/upstream.ts` (22 lines)**: Enhances `applyClaudeCodeSystem()`:
  ```typescript
  const model = typeof next.model === "string" ? next.model.toLowerCase() : "";
  const support = anthropicThinkingSupport(model);

  if (!support.adaptive) {
    delete next.context_management;
    delete next.thinking;
    delete next.output_config;

    if (Array.isArray(next.messages)) {
      next.messages = next.messages.map((m: unknown) => {
        if (typeof m === "object" && m !== null && (m as Record<string, unknown>).role === "system") {
          return { ...(m as Record<string, unknown>), role: "user" };
        }
        return m;
      });
    }
  }
  ```

### 2.4 Compile the Project
Compile TypeScript into production artifacts:
```powershell
pnpm build
```
The compiled output is saved in `dist/cli.mjs` and `dist/web/`.

---

## 3. Step 2: OpenCode Configuration (Port 8787)

OpenCode is designed for general-purpose LLM providers using standard API keys.

### 3.1 Port Used
- **Gateway Port**: `8787` (`http://127.0.0.1:8787`)
- **Dashboard URL**: `http://127.0.0.1:8787/logs`

### 3.2 Jevonian Configuration (`~/.config/jevonian/config.json`)
Copy the template [config-opencode.json](./config-opencode.json) to `C:\Users\<user>\.config\jevonian\config.json`:

```json
{
  "listen": {
    "host": "127.0.0.1",
    "port": 8787
  },
  "defaultProvider": "primary-provider",
  "providers": [
    {
      "name": "primary-provider",
      "type": "openai",
      "baseUrl": "https://your-api-endpoint.example.com/v1",
      "auth": "api-key",
      "apiKey": "YOUR_API_KEY_HERE",
      "models": [
        { "id": "deepseek-v4.1-flash" },
        { "id": "qwen3.8-flash" },
        { "id": "qwen3.7-plus" },
        { "id": "glm-5.3" },
        { "id": "qwen3.8-max" }
      ],
      "injectStreamUsage": true,
      "syncModels": false
    }
  ],
  "routing": {
    "mode": "auto",
    "routings": [
      {
        "id": "plan",
        "label": "Plan",
        "description": "High difficulty: architecture design, deep reasoning, system coordination",
        "models": ["glm-5.3", "qwen3.8-max"],
        "effort": "high"
      },
      {
        "id": "execute",
        "label": "Execute",
        "description": "Medium difficulty: code implementation, debugging, tool loops, refactoring",
        "models": ["qwen3.8-flash", "qwen3.7-plus"],
        "effort": "medium"
      },
      {
        "id": "utility",
        "label": "Background",
        "description": "Low difficulty: repository search, summarization, file indexing",
        "models": ["qwen3.7-plus", "qwen3.8-flash"],
        "effort": "low"
      },
      {
        "id": "chat",
        "label": "Chit-chat",
        "description": "Low difficulty: greetings, small talk, casual queries",
        "models": ["deepseek-v4.1-flash", "qwen3.8-flash"],
        "effort": "low"
      }
    ],
    "tiers": {
      "plan": ["glm-5.3", "qwen3.8-max"],
      "execute": ["qwen3.8-flash", "qwen3.7-plus"],
      "utility": ["qwen3.7-plus", "qwen3.8-flash"],
      "chat": ["deepseek-v4.1-flash", "qwen3.8-flash"]
    },
    "capacities": {
      "deepseek-v4.1-flash": { "efforts": ["low"] },
      "qwen3.8-flash": { "efforts": ["low", "medium"] },
      "qwen3.7-plus": { "efforts": ["low", "medium"] },
      "glm-5.3": { "efforts": ["high", "xhigh"] },
      "qwen3.8-max": { "efforts": ["high", "xhigh"] }
    },
    "sessionTtlMinutes": 720,
    "quotaGuard": {
      "enabled": true,
      "lowPercent": 10
    },
    "brains": [
      {
        "channel": "typesafe",
        "timeoutMs": 8000,
        "minConfidence": 0.6
      }
    ],
    "brainPicksEffort": false
  }
}
```

### 3.3 Task Difficulty & Model Mapping
- **`chat` (Low Effort)**: Fast flash models (e.g. `deepseek-v4.1-flash`) — optimal for greetings, small talk, and basic queries without tool calling.
- **`utility` (Low Effort)**: Plus-tier models (e.g. `qwen3.7-plus`) — fast background scans, file indexing, and session summaries.
- **`execute` (Medium Effort)**: Coding models (e.g. `qwen3.8-flash`, `qwen3.7-plus`) — code writing, test generation, and tool execution loops.
- **`plan` (High Effort)**: Frontier reasoning models (e.g. `glm-5.3`, `qwen3.8-max`) — multi-step task breakdowns, architectural plans, and code reviews.

### 3.4 OpenCode Client Configuration (`~/.config/opencode/opencode.json`)
Configure OpenCode to use the local Jevonian router:
```json
{
  "baseURL": "http://127.0.0.1:8787/v1",
  "model": "jevonian/auto"
}
```

### 3.5 Starting the OpenCode Gateway
You can launch the OpenCode gateway using either of the following:

```powershell
# Option A: Run the deployment runner script (Recommended)
node run-opencode.js
# Or double-click: run-opencode.bat

# Option B: Directly via Jevonian CLI
cd ../jevonian
node dist/cli.mjs serve
```

---

## 4. Step 3: Claude Code Configuration (Port 8790)

Claude Code connects to official Anthropic models using your Claude Max or Pro subscription via OAuth.

### 4.1 Port Used
- **Gateway Port**: `8790` (`http://127.0.0.1:8790`)
- **Dashboard URL**: `http://127.0.0.1:8790/logs`

### 4.2 Jevonian Configuration (`~/.config/jevonian-claude/config.json`)
Copy the template [config-claudecode.json](./config-claudecode.json) to `C:\Users\<user>\.config\jevonian-claude\config.json`:

```json
{
  "listen": {
    "host": "127.0.0.1",
    "port": 8790
  },
  "defaultProvider": "claude-subscription",
  "providers": [
    {
      "name": "claude-subscription",
      "type": "anthropic",
      "baseUrl": "https://api.anthropic.com/v1",
      "auth": "oauth",
      "oauthSource": "claude-code",
      "billing": "subscription",
      "models": [
        { "id": "claude-haiku-4-5-20251001" },
        { "id": "claude-sonnet-5" },
        { "id": "claude-opus-5-5" }
      ],
      "injectStreamUsage": true,
      "headers": {
        "user-agent": "claude-cli/2.1.282 (external, cli)",
        "anthropic-beta": "context-management-2025-06-27,compact-2026-01-12"
      },
      "syncModels": false
    }
  ],
  "routing": {
    "mode": "auto",
    "routings": [
      {
        "id": "plan",
        "label": "Plan",
        "description": "High complexity reasoning & architectural blueprints (Claude Opus 5.5, xhigh effort)",
        "models": ["claude-opus-5-5"],
        "effort": "xhigh",
        "forceEffort": true
      },
      {
        "id": "execute",
        "label": "Execute",
        "description": "Implementation, bug fixing, tool loops (Claude Sonnet 5, medium effort)",
        "models": ["claude-sonnet-5"],
        "effort": "medium",
        "forceEffort": true
      },
      {
        "id": "utility",
        "label": "Background",
        "description": "Background repo scans, summaries, titles (Claude Sonnet 5, low effort)",
        "models": ["claude-sonnet-5"],
        "effort": "low",
        "forceEffort": true
      },
      {
        "id": "chat",
        "label": "Chit-chat",
        "description": "Greetings, casual conversation, quick queries (Claude Haiku 4.5, low effort)",
        "models": ["claude-haiku-4-5-20251001"],
        "effort": "low",
        "forceEffort": true
      }
    ],
    "tiers": {
      "plan": ["claude-opus-5-5"],
      "execute": ["claude-sonnet-5"],
      "utility": ["claude-sonnet-5"],
      "chat": ["claude-haiku-4-5-20251001"]
    },
    "capacities": {
      "claude-haiku-4-5-20251001": { "efforts": ["low"] },
      "claude-sonnet-5": { "efforts": ["low", "medium", "high"] },
      "claude-opus-5-5": { "efforts": ["high", "xhigh"] }
    },
    "sessionTtlMinutes": 720,
    "quotaGuard": {
      "enabled": true,
      "lowPercent": 10
    },
    "brains": [
      {
        "channel": "typesafe",
        "timeoutMs": 8000,
        "minConfidence": 0.6
      }
    ],
    "brainPicksEffort": false
  }
}
```

### 4.3 Claude Code Task & Effort Breakdown
- **`chat` (Low Effort)**: **`claude-haiku-4-5-20251001`** ($1 / $5 per MTok). Ultra-fast conversational interactions.
- **`utility` (Low Effort)**: **`claude-sonnet-5`** ($2 / $10 per MTok). Background repo context reading, summaries, and title generation.
- **`execute` (Medium Effort)**: **`claude-sonnet-5`** ($2 / $10 per MTok). Code editing, bug debugging, test execution, and bash tool calls.
- **`plan` (XHigh Effort)**: **`claude-opus-5-5`** ($4 / $20 per MTok). Deepest frontier intelligence for multi-region system design and architectural blueprints.

> [!IMPORTANT]
> **Why `"forceEffort": true` is required:**
> By default, the Claude Code CLI (`claude`) attaches `"output_config": { "effort": "high" }` on every outgoing API request.
> Under standard Jevonian routing semantics, explicit client-specified effort overrides the router's tier effort (`"client set wins"`).
> Setting `"forceEffort": true` on each tier instructs Jevonian to enforce the configured tier effort (`low`, `medium`, `xhigh`) over Claude Code's default `high` flag.

### 4.4 Claude Code Client Configuration (`~/.claude/settings.json`)
Configure Claude Code to send all traffic to port 8790:
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8790",
    "ANTHROPIC_AUTH_TOKEN": "jevonian-local",
    "ANTHROPIC_API_KEY": "",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "jevonian/auto",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "jevonian/auto",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "jevonian/utility",
    "CLAUDE_CODE_SUBAGENT_MODEL": "jevonian/auto"
  }
}
```

### 4.5 Starting the Claude Code Gateway
Run the launcher script [run-claude.js](./run-claude.js) or double-click the batch file:

```powershell
node run-claude.js
# Or double-click: run-claude.bat
```

---

## 5. Step 4: Verification & Live Health Checks

### 5.1 Automated All-in-One Verification Script
Run the automated verification script [test-verify.js](./test-verify.js) to probe both gateways and test the OpenCode tool wire normalizer:

```powershell
node test-verify.js
```

### 5.2 Manual Endpoint Checks
Verify both servers individually via curl or PowerShell:

```powershell
# OpenCode (Port 8787)
curl http://127.0.0.1:8787/v1/models

# Claude Code (Port 8790)
curl http://127.0.0.1:8790/v1/models
```

Expected response on both:
```json
{
  "object": "list",
  "data": [
    { "id": "jevonian/auto" },
    { "id": "jevonian/plan" },
    { "id": "jevonian/execute" },
    { "id": "jevonian/utility" },
    { "id": "jevonian/chat" }
  ]
}
```

### 5.2 Real Verification Runs
Execute test turns from terminal:

```powershell
# Test 1: Chat Routing (Triggers Haiku 4.5 on Port 8790)
claude -p "Hello! Who are you?" --dangerously-skip-permissions

# Test 2: Coding Routing (Triggers Sonnet 5 on Port 8790)
claude -p "Write an IPv4 validator function in TypeScript." --dangerously-skip-permissions

# Test 3: Plan Routing (Triggers Opus 5.5 on Port 8790)
claude -p "Design an architectural blueprint for a zero-downtime database migration." --dangerously-skip-permissions
```

### 5.3 Live Dashboards
Inspect the live routing decisions, token usage, and latency in your browser:
- OpenCode: [http://127.0.0.1:8787/logs](http://127.0.0.1:8787/logs)
- Claude Code: [http://127.0.0.1:8790/logs](http://127.0.0.1:8790/logs)

---

## 6. Troubleshooting: OpenCode & Strict OpenAI-Compatible Providers

### Error: `if content is list. item must be dict and key[type] should in dict`
- **Cause**: OpenCode stores multi-turn conversation histories with Anthropic-style blocks (`type: "tool_use"` and `type: "tool_result"`). When talking to an OpenAI-compatible endpoint (`/v1/chat/completions`), OpenCode's `@ai-sdk/openai-compatible` client leaves these blocks inside the `message.content` array. Strict Python validators on upstreams like Alibaba Cloud Model Studio reject this because OpenAI-wire `content` arrays may only contain `{ type: "text" }` or `{ type: "image_url" }`.
- **Solution**: Jevonian includes a built-in normalizer (`normalizeOpenAIMessages` in `src/wire.ts`) applied before egress in `src/upstream.ts`. It automatically converts:
  1. `type: "tool_use"` inside assistant content into standard OpenAI `tool_calls`.
  2. `type: "tool_result"` inside user content into separate OpenAI `role: "tool"` messages.
  3. Text array blocks into merged strings so strict schemas are 100% compliant.

> [!NOTE]
> For the complete technical post-mortem, anatomy of the error, and reproduction evidence, see [OPENCODE_ISSUE_POSTMORTEM.md](./OPENCODE_ISSUE_POSTMORTEM.md).

---

## 7. OpenCode Auto-Compaction & Multimodal Optimization (`prune: true`)

### Error: `Download multimodal file timed out`
- **Cause**: During UI automation (e.g., Android `android_Snapshot`), OpenCode captures screenshots and stores them as inline base64 Data URIs (`data:image/png;base64,...`) in the chat history. By default, OpenCode has **`compaction.prune: false`**, which causes **all previous screenshots to be re-transmitted on every single turn**. After multiple snapshot operations, the payload balloons to 200,000+ tokens and tens of megabytes, causing upstream multimodal gateways (such as Alibaba Cloud Model Studio) to hit a 60+ second timeout.
- **Solution**: Configure OpenCode's official V2 compaction settings in `opencode.json`:
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
  - **`prune: true`**: Automatically removes historical tool outputs (such as old screenshots) once they are superseded, preventing base64 bloat.
  - **`auto: true`**: Performs automatic compaction before dispatching requests when context grows.
  - **`reserved: 10000`**: Preserves a 10k token safety buffer to avoid context overflow.

### In-Session Quick Recovery
If an ongoing OpenCode session hits a context bloat or timeout error, type:
```text
/compact
```
This forces an immediate summarization and wipes stale base64 images from active memory without losing conversation context.

---

## 8. Multi-Client Matrix: Kilo CLI & Ref MCP Integration

### 8.1 Kilo CLI vs OpenCode
Both Kilo CLI and OpenCode can be routed through Jevonian on port 8787:

| Client | Configuration File | Image Handling | Compaction Model |
|---|---|---|---|
| **OpenCode** | `opencode.json` | Inlines base64 into history | Enabled via `"compaction": { "prune": true }` |
| **Kilo CLI** | `kilo.json` | Stores tool results cleanly | Native lightweight history model |

To run Kilo CLI through Jevonian:
```powershell
# Interactive TUI mode
kilo

# One-shot command
kilo run "analyze repository structure"

# Explicit tier pinning
kilo -m jevonian/plan
```

### 8.2 Ref MCP Integration (Technical Documentation Search)
The Ref MCP server (`ref-tools-mcp`) provides fast, token-efficient technical documentation searches for APIs, frameworks, and tools.

1. **System Environment Registration:**
   ```powershell
   setx REF_API_KEY "YOUR_REF_API_KEY"
   ```
2. **Client Manifest Configuration (`opencode.json` / `kilo.json`):**
   ```json
   "mcp": {
     "ref": {
       "type": "local",
       "command": ["npx", "-y", "ref-tools-mcp"],
       "environment": {
         "REF_API_KEY": "YOUR_REF_API_KEY"
       },
       "enabled": true,
       "timeout": 30000
     }
   }
   ```
   Both OpenCode and Kilo CLI can now call `ref_search_documentation` and `ref_read_url` dynamically to query live upstream documentation without polluting context windows.

---

## 9. OpenCode V2 Migration & Native Configuration

OpenCode V2 (`https://opencode.ai/v2/docs`) introduces a stateful event-sourced runtime with checkpoint-based compaction and a streamlined schema.

### 9.1 Native V2 Configuration Template (`opencode.v2.json`)
A complete native V2 configuration is included in this repository as [`opencode.v2.json`](./opencode.v2.json):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "compaction": {
    "auto": true,
    "keep": {
      "tokens": 15000
    },
    "buffer": 20000
  },
  "media": {
    "image": {
      "auto_resize": true,
      "max_width": 1280,
      "max_height": 1280,
      "max_base64_bytes": 1048576
    }
  },
  "plugins": [
    "context-mode"
  ],
  "model": "jevonian/auto",
  "permissions": [
    { "action": "*", "resource": "*", "effect": "allow" }
  ],
  "providers": {
    "jevonian": {
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "local-no-key"
      },
      "models": {
        "auto": {
          "name": "Jevonian Auto (Dynamic Tier Router)",
          "limit": { "context": 160000, "output": 65536 },
          "capabilities": { "tools": true, "input": ["text", "image"], "output": ["text"] }
        }
      }
    }
  },
  "mcp": {
    "servers": {
      "ref": {
        "type": "local",
        "command": ["npx", "-y", "ref-tools-mcp"],
        "environment": { "REF_API_KEY": "{env:REF_API_KEY}" },
        "disabled": false,
        "timeout": { "catalog": 30000, "execution": 30000 }
      }
    }
  }
}
```

### 9.2 Key Differences & What Is Obsolete in V2
1. **`compaction.prune` is Obsolete:** OpenCode V2 ignores `prune` with a warning. V2 uses checkpoint-based compaction (`keep.tokens` + `buffer`), storing prior history as plain text summaries and only retaining the recent token budget. Raw historical base64 images are natively excluded.
2. **Provider Syntax:** Uses `providers` with `package: "aisdk:@ai-sdk/openai-compatible"` and `settings`.
3. **Permissions:** Uses ordered array `permissions: [ { "action": "*", "resource": "*", "effect": "allow" } ]`.
4. **MCP Servers:** Nested under `mcp.servers` with `disabled: false`.

---

## 10. Deployment Post-Mortem & Troubleshooting Guide

During initial deployment in Windows development environments, several non-obvious traps and environmental conflicts were identified and resolved. This section documents each issue, its root cause, and the exact sequence of fixes applied.

### 10.1 The Windows Command Processor Hijack (`AutoRun` & DOSKEY Macros)
- **Symptom:**
  Running `claude --dangerously-skip-permissions` immediately opened Microsoft Edge browser, printed unwanted banners or `jevonian update` notifications, or attempted to route to port 8797 instead of 8790.
- **Root Cause:**
  A Windows registry entry located at:
  `HKCU\Software\Microsoft\Command Processor\AutoRun`
  was configured to run a legacy macro script (`jev.doskey`) on every single `cmd.exe` initialization. This macro hijacked the `claude` command to execute an obsolete legacy launcher script.
- **Why It Resisted File Edits:**
  Windows `doskey` macros reside in the **active memory** of currently open terminal windows. Even after deleting files on disk, any CMD window opened prior to the fix continued to run the cached macro.
- **Resolution:**
  1. Delete the registry auto-run hook permanently:
     ```powershell
     reg delete "HKCU\Software\Microsoft\Command Processor" /v AutoRun /f
     ```
  2. Flush the macro from any currently open CMD window:
     ```cmd
     doskey claude=
     doskey jev=
     ```
  3. Ensure Claude Code routes cleanly via native configuration (`~/.claude/settings.json`) without any wrapper scripts or DOSKEY macros.

---

### 10.2 Claude Code Hardcoded Effort & The `forceEffort: true` Rule
- **Symptom:**
  Every model in Jevonian dashboard showed `effort: high` (or `xhigh`), ignoring the configured tier efforts (`low` for chat/utility, `medium` for execute).
- **Root Cause:**
  1. Claude Code CLI (v2.1.282+) automatically injects `"output_config": { "effort": "high" }` on every outgoing API request.
  2. Upstream Jevonian architecture follows the design principle: **"explicit client-specified effort wins over router tier defaults"**.
  3. Consequently, Claude Code's hardcoded `effort: high` overrode all tier settings in `config.json`.
  4. Additionally, project-local `.claude/settings.json` contained `"effortLevel": "high"`, forcing high-effort reasoning chains.
- **Resolution:**
  1. Add `"forceEffort": true` to every tier in `config-claudecode.json` and `~/.config/jevonian-claude/config.json`:
     ```json
     {
       "id": "execute",
       "label": "Execute",
       "models": ["claude-sonnet-5"],
       "effort": "medium",
       "forceEffort": true
     }
     ```
  2. Remove `"effortLevel": "high"` from project-local `.claude/settings.json` so Claude Code does not force high effort locally.
  3. Result: Jevonian now enforces `chat: low`, `utility: low`, `execute: medium`, and `plan: xhigh` strictly according to the configured routing policy.

---

### 10.3 Background Gateway Daemon Requirement
- **Symptom:**
  Running `claude` returned `Connection refused` (ECONNREFUSED) to `http://127.0.0.1:8790`.
- **Root Cause:**
  Claude Code is purely an API client; it does not launch the Jevonian gateway on demand. The gateway must be running in the background before Claude Code CLI is invoked.
- **Resolution:**
  1. Launch the gateway via `run-claude.bat` or `node run-claude.js` before launching Claude Code.
  2. For automated background operation, run `run-claude.js` via a background task manager, Windows Task Scheduler, or PM2 (`pm2 start run-claude.js --name jevonian-claude`).

---

### 10.4 TypeSafe API Credential Auto-Discovery
- **Symptom:**
  TypeSafe brain intelligence failed to activate, falling back to heuristic routing.
- **Root Cause:**
  Original deployment scripts looked for `typesafe-api.txt` only in the current working directory.
- **Resolution:**
  Updated `run-claude.js` to automatically inspect:
  - `D:/work/sourcecode/workflow_reimbursement/config/typesafe-credential.txt`
  - `credential/typesafe-api.txt`
  - `TYPESAFE_API_KEY` environment variable
  This ensures seamless credential resolution across different project layouts.

---

## 11. Context Window & Token Compaction Architecture

### 11.1 Why Tokens Fill Up So Quickly (Compaction Analysis)
A common issue observed in real-world usage is rapid context saturation:
```text
* Compacting conversation... (1m 5s · ↓ 3.8k tokens)  0% until auto-compact
```

This occurs due to the convergence of four key factors:

1. **Unknown Model Context Clamp (200k Token Ceiling):**
   - Claude Code CLI maintains an internal catalog of known model identifiers.
   - When configured with a custom router model like `jevonian/auto`, Claude Code prints a warning:
     `"jevonian/auto isn't described by this version's model catalog... auto-compact keeps this session within 200k tokens."`
   - Even if the underlying model supports 1,000,000+ tokens, Claude Code clamps the active session to **200,000 tokens** (triggering compaction around 160k-180k tokens).

2. **Bulk File & MCP Memory Ingestion:**
   - Prompting Claude Code to read entire session folders (e.g. `sessions/` containing over 10 MB of text) or dumping an entire MCP memory graph (`read_graph`) ingests millions of tokens into the conversation history in a single tool step.
   - For example, 10.2 MB of text equals approximately **2.6 million tokens**—over **13 times** the 200k token ceiling of Claude Code!
   - This instantly triggers conversation auto-compaction.

3. **High Effort Reasoning Tokens:**
   - When running with `high effort`, Claude generates between 8,000 and 32,000 thinking/reasoning tokens per turn. These tokens count directly against the active context limit.

4. **Compaction Reduction Limitation:**
   - In the compaction screenshot, a 1-minute compaction cycle only reclaimed `↓ 3.8k tokens` (`0% until auto-compact remaining`).
   - This occurs because Claude Code cannot compact tool outputs that were generated in the immediate active turn. If a single prompt injects 150k+ tokens of file dumps, compaction has almost nothing historical to trim!

---

### 11.2 Best Practices for Managing Context in Large Repositories

| Practice | Bad Approach ❌ | Recommended Approach ✅ |
|---|---|---|
| **Directory Inspection** | `"read session files from this folder"` (Dumps 10MB into context) | Ask targeted questions or use search: `"Find sessions mentioning invoice approval"` |
| **MCP Knowledge Graphs** | Calling `read_graph` to dump everything | Use targeted queries: `search_nodes`, `open_nodes` |
| **Reasoning Effort** | Leaving effort on `high` for all tasks | Use `"forceEffort": true` in Jevonian to enforce `medium` or `low` where appropriate |
| **Context Window Override** | Accepting the default 200k clamp | Add `CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000"` to `~/.claude/settings.json` or append `[1m]` to model |





