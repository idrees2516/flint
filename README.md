# Flint

**Cloud sandboxes + agent orchestration — every feature boat.dev has, the prime-agent agent runtime on top, at a fraction of the cost.**

Flint is a self-hostable platform that combines:

1. **A sandbox cloud** — Firecracker-style microVM workspaces with per-second billing, auto-hibernate cost optimization (~92% cheaper than idle), snapshots, templates, SSH/web-terminal, and a 24-lane lifecycle orchestrator.
2. **A full RLM agent runtime** (feature-complete port of [PrimeIntellect's prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) paradigms) — persistent Python kernels per session, programmatic tool calling, subagents with their own kernels, A2A messaging, goals with token budgets, heartbeats/cron, autonomous completion gates, compaction, a self-improving continual harness, MCP, factory multi-agent workflows, and a 20-model catalog across 15 providers with live cost tracking.
3. **An ACP editor bridge** — drive Flint from Zed/Neovim over the Agent Client Protocol.

---

## Quickstart

```bash
npm install
npx prisma db push          # SQLite via Prisma
npm run dev                 # http://localhost:3000
```

Optional environment (all have sane defaults):

```bash
FLINT_REALTIME_URL=http://127.0.0.1:3004   # socket.io mini-service (optional)
ZAI_API_KEY=...                            # first-party model provider
```

## The RLM runtime (prime-agent parity)

| Surface | What it does |
|---|---|
| **Kernel** (`src/lib/flint/kernel.ts`, `mini-services/flint-kernel/`) | Persistent supervised CPython process per session — NDJSON eval protocol, host-call bridge (19 host fns), per-variable snapshots, disk persistence across server restarts, idle eviction + lazy resume |
| **Sessions** (`src/lib/flint/rlm.ts`) | PTC turn loop (model → fenced python → kernel eval → observation), compaction with keep-10 boundary, fork with kernel snapshot copy, per-turn cost accounting |
| **Subagents / Swarm** | `spawn()`/`collect()` host fns, bounded concurrency (12), depth ≤ 4, own kernel + model per child |
| **A2A messaging** | Nuclear-family enforcement (parent ↔ children ↔ siblings), broadcast, steer/follow-up delivery, inbox drain at iteration boundaries |
| **Goals + autonomous** | Objectives with token budgets + continuation driver; autonomous mode with turn/token/time budgets and shell completion gates (failures fed back, gate retries) |
| **Heartbeats** | 5-field cron, 30s scheduler tick, steer/follow-up modes, busy-rescheduling |
| **Harness** (self-improving) | Agent-editable memories / prompt notes / skills / subagent specs; refine pipeline (planner LLM → planned refinement → versioned apply → rollback) |
| **Factory** | Declarative FSM/DAG machines — plan→implement→review→fix loops, foreach fan-out, joins, guards, budgets, failure policies |
| **MCP** | JSON-RPC 2.0 over HTTP (+SSE), tool policies, bearer auth, catalog (Notion, Linear, GitHub, Serper, …) |
| **Models** | 20 models × 15 providers (Z.ai, Prime Inference, Anthropic, OpenAI, Google, DeepSeek, Moonshot, MiniMax, xAI, Mistral, Groq, Cerebras, Fireworks, OpenRouter, HF) + user-model registry |

## ACP — use Flint inside your editor

Flint speaks the [Agent Client Protocol](https://agentclientprotocol.com) over a stdio adapter, exactly the surface prime-agent serves (`initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/close`, `session/set_config_option` → outgoing `session/update` notifications with namespaced `ai.flint.agent` meta).

**Zed** — drop into `~/.config/zed/agents.json`:

```json
{
  "flint": {
    "name": "Flint",
    "command": "node",
    "args": ["/path/to/flint/scripts/flint-acp.mjs"],
    "env": { "FLINT_URL": "http://127.0.0.1:3000" }
  }
}
```

Restart Zed → open the agent panel → pick Flint. Kernel evals stream as `tool_call` events, the agent's answer streams as `agent_message_chunk`, `Esc` maps to `session/cancel`, and the model/thinking-level can be switched live per session.

```bash
# run the adapter by hand (it speaks ndjson JSON-RPC on stdio)
FLINT_URL=http://127.0.0.1:3000 node scripts/flint-acp.mjs

# E2E test against a running server
node scripts/test-acp-e2e.mjs
node scripts/test-acp-cancel.mjs
```

### ACP HTTP surface (what the adapter talks to)

| Route | Purpose |
|---|---|
| `POST /api/flint/acp/connect` | open a connection (one per adapter process) |
| `GET  /api/flint/acp/connect?id=` | SSE stream of translated session events |
| `POST /api/flint/acp/sessions` | `session/new` (cwd, mcpServers) and `session/load` |
| `POST /api/flint/acp/sessions/:id/prompt` | run a turn → `{ stopReason, final }` |
| `POST /api/flint/acp/sessions/:id/cancel` | flag turn cancellation (lands at iteration boundary) |
| `POST /api/flint/acp/sessions/:id/close` | park kernel (snapshot survives), detach |
| `GET/POST /api/flint/acp/sessions/:id/config` | model · thought_level config options |
| `GET  /api/flint/acp/status` | live bridge status (used by the Studio ACP tab) |

## Platform API (selection)

```
POST /api/flint/sandboxes            provision + boot a workspace
POST /api/flint/sandboxes/:id/action start · stop · hibernate · fork · snapshot
POST /api/flint/sessions             create an RLM agent session
POST /api/flint/sessions/:id/messages  talk to the agent (PTC turns)
POST /api/flint/sessions/:id/kernel    eval code in the session kernel
POST /api/flint/sessions/:id/compact   fold the transcript
POST /api/flint/factory/:slug/run      run a multi-agent machine
POST /api/flint/sessions/:id/autonomous goals + completion gates
```

Full surface: 40+ routes under `/api/flint/*` (sessions, goals, heartbeats, harness, MCP, factory, models, metrics, cost, keys, templates, tasks, messages, sandboxes, ACP).

## Repository layout

```
src/lib/flint/          runtime: kernel, rlm, goals, heartbeats, harness,
                        factory, mcp, models, acp (ACP bridge), events
src/app/api/flint/      40+ REST routes
src/components/flint/   UI: dashboard, sandboxes, studio (RLM cockpit), …
mini-services/          flint-kernel (CPython kernel), flint-realtime (socket.io)
scripts/                flint-acp.mjs (ACP adapter), test-acp-*.mjs (E2E)
prisma/                 schema (10 agent-runtime models)
```

## Cost posture vs boat.dev

Same 2vCPU·4GB workload: **$0.008/hr vs $0.018/hr**, per-second billing, free when stopped, and the auto-hibernate optimizer folds idle sandboxes to snapshot-only pricing (~92% savings). The agent runtime meters per-turn token costs across every provider in the catalog — subagents, compaction and heartbeats included.

## License

MIT
