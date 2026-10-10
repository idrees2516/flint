# Flint Platform Worklog

---
Task ID: 1
Agent: Super Z (main agent)
Task: Implement prime-agent (PrimeIntellect-ai/prime-agent) feature parity in Flint — RLM runtime, sessions, subagents, A2A, goals, autonomous mode, heartbeats, continual harness, MCP, factory, model catalog, Studio UI.

Work Log:
- Researched prime-agent repo comprehensively (RLM paradigm, kernel protocol, sessions/JSONL, subagents, A2A, factory machines, decision API, compaction, harness/refine, MCP, model catalog, autonomous gates, heartbeats/cron, cost tracking).
- Schema (prisma/schema.prisma): added 10 models — AgentSession, SessionMessage, AgentMessage, AgentGoal, Heartbeat, HarnessItem, Refinement, McpServer, FactoryMachine, FactoryRun. Pushed to SQLite + regenerated client.
- Kernel (mini-services/flint-kernel/kernel.py + src/lib/flint/kernel.ts):
  - Persistent CPython process per session; NDJSON protocol over stdin/stdout-dup (eval / host_call / host_result / snapshot / restore / vars / shutdown).
  - REPL semantics via AST (trailing-expression echo), stdout capture, background BashHandle (.output/.tail/.poll/.kill), edit/read/write/ls tools, bash blocklist.
  - Host bridge: kernel code calls host(fn, *args) → blocks on kernel side → TS dispatches to registered host fns (19 registered) → replies over stdin.
  - KernelManager: supervised restart w/ backoff + identity guard, idle eviction (30 min) with snapshot-keep + lazy resume, per-variable pickled snapshots (4 MiB cap/manifest), DISK PERSISTENCE (sandboxes/.kernels/<id>/snapshot.bin) so state survives full server restarts.
  - Fixed deadlock in host-call pump (stale waiters) → waitHostCall/drainHostCalls design.
- Model catalog (src/lib/flint/models.ts): 20 models × 15 providers (zai/prime-inference/anthropic/openai/google/deepseek/moonshot/minimax/xai/mistral/groq/cerebras/fireworks/openrouter/hf), thinking levels, per-model pricing, user-model registry.
- MCP (src/lib/flint/mcp.ts): JSON-RPC 2.0 over HTTP (+SSE responses), initialize handshake, tools/list + tools/call, tool policies (enabledTools/disabledTools), bearer env auth, service catalog (notion/linear/slack/serper/github/postgres/filesystem/puppeteer), stdio documented as sandbox-launched.
- Harness (src/lib/flint/harness.ts): 4 kinds (memory/prompt_note/skill/subagent_spec), global+session scope, search, prompt blocks injection, refine pipeline (planner LLM → planned Refinement → apply bumps version → rollback restores content), refinement history.
- RLM engine (src/lib/flint/rlm.ts): session CRUD + fork (copies transcript + kernel snapshot), append-only SessionMessage transcript with compaction boundary (summary msgs), layered system prompt (core + harness blocks + MCP + env), PTC turn loop (model → fenced python → kernel eval → observation; final-iteration nudge; done-flag signaling), auto-compaction at ~24k tokens (keep-10), A2A messaging w/ nuclear-family enforcement + broadcast + steer/follow-up, subagent spawn/collect (bounded 12 concurrent, own kernel+model, depth ≤ 4), 19 host fns (spawn/collect/progress_note/list_agents/observe_agent/recent_messages/send_message/mcp_*/harness_*/compact_run/goal_get/goal_complete/factory_run/metrics/websearch/done), per-turn cost accounting, post-turn disk snapshots.
- Goals/autonomous (src/lib/flint/goals.ts): goals w/ token budgets + continuation driver (re-prompts until goal_complete/flint_done/exhausted); autonomous mode w/ turn/token/time budgets + shell completion gates run in the kernel (failures fed back, gate retries).
- Heartbeats (src/lib/flint/heartbeats.ts): 5-field cron parser + nextFire, 30s scheduler tick, steer/follow-up modes, busy-session rescheduling.
- Factory (src/lib/flint/factory.ts): FSM/DAG machines — agent + join nodes, foreach fan-out (bounded maxParallel), guards (JS expressions over node results), budgets, failure policies (fail/retry/skip), wave-based topological execution, node states persisted per run. Seeded builder/pr-manager/review-sweep machines.
- API routes (29 total): sessions CRUD, messages (turns), fork, compact, autonomous, kernel eval/vars, goals, heartbeats, harness + refine, mcp + tools + call, factory + run + stop, models, messages (A2A).
- Bootstrap: boots orchestrator + kernels + host fns + heartbeats.
- UI: new Agent Studio view (studio.tsx + studio-dock.tsx) — session rail w/ subagent forest, chat pane w/ typed message bubbles (code/stdout/summary/a2a/gate/goal), model picker, compact/fork, Kernel REPL tab (live vars + eval), Swarm tab (spawn + A2A + roster), Goals tab (+ autonomous w/ gates), Heartbeats tab, Harness tab (4 kinds + refine apply/rollback), MCP tab (catalog + tools), Factory tab (machines + runs). Nav + landing page updated (RLM hero, Studio CTA, new API list).
- Seeds: harness items (4), MCP servers (5), factory machines (3), demo RLM session w/ transcript.
- Fixed: template-literal backticks in system prompt; ZAI typing (structural client); Semaphore misuse; label-echo bug (model echoing "assistant code:") → fenced-block history mapping + label stripping + final-iteration nudge; kernel state loss on restart → disk snapshots + post-turn snapshot.

Stage Summary:
- ALL prime-agent core features implemented & E2E-verified live: kernel persistence (answer=42 across turns; disk_var=999 across full server restart), host calls, subagent spawn/collect (2**10=1024 via child), factory builder run (plan→implement→review→fix, 34.5s, real file verification), compaction (summary w/ goals/facts/state), goals (budget enforcement + completion), A2A (family enforcement, broadcast, delivery), harness refine (plan→apply v2→rollback), MCP catalog/tools, heartbeats cron, 20-model catalog, cost tracking (per session/goal/turn).
- Production build passes (npm run build ✓, 21 static pages, all 29 API routes). Studio UI verified in headless browser — zero console/page errors.
- Deliverables: live dev server on :3000, screenshots in download/flint-studio*.png.
