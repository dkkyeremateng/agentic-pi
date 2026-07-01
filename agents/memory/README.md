# Agent memory

Per-agent memory files (`<agent>.md`) live here. Each agent writes its own durable
lessons via the `remember` tool during a run; those candidates are committed to the
agent's file at run finalize **only if the run objectively passed**, then injected
into the agent's prompt on future runs.

Managed by `utils/workflow/memory.ts` (tool: `extensions/agent-memory.ts`). Files
are created automatically on the first successful run that saved a lesson. Every
write is a normal git diff — review/revert like any other change. Disable the whole
loop with `PI_AGENT_MEMORY=0`.
