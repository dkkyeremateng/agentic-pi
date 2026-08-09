# Agent harness review — findings & implementation plan (2026-08-08)

Scope: the agent workflow harness — `extensions/agent-workflow.ts`, `extensions/dispatch.ts`,
`extensions/agent-memory.ts`, and `utils/workflow/*` (~16.5k lines incl. tests). Four parallel
review passes (orchestrator core, workflow core, extension entry points, support modules), findings
deduplicated and the top items re-verified against the code.

**Totals: 5 high, ~10 medium, ~17 low** (deduped; two reviewers independently converged on A1, B1, and G1).

Suggested delivery: one PR per cluster below, ordered A → G (severity-first; A–D are behavior
bugs, E–G are safety/hygiene). Verification for every PR: `npx tsx --test utils/workflow/*.test.ts`
plus `node --experimental-strip-types --check` on touched files. No co-author trailers.

## Implementation status — all clusters landed (2026-08-09)

Every finding A1–G8 is implemented. Suite: 702 → 761 tests, 0 failures; `tsc --noEmit` clean;
every changed file passes `node --experimental-strip-types --check`.

Deviations from the plan as written, all deliberate:

- **B1** — a *wipe* only clears the current project's `projectSessionHash(cwd)` subdir; other
  projects' subdirs get the age-based TTL sweep only, so a concurrent run in another repo cannot
  have its live session deleted. `dispatch-history.jsonl` is excluded from both paths.
- **C2/C5** — the two stdout closures were extracted into an exported `handleSpawnLine()` so the
  streaming and close-time paths share one dispatcher (and became unit-testable at all).
- **E1** — the prepended switch is `switch --force`. Found during review: the caller backs up with
  `stash create` + `stash store`, which (unlike `stash push`) leaves the tree DIRTY, so a plain
  `switch` would abort on "local changes would be overwritten" and take the whole revert with it.
  Those changes are exactly what the following `reset --hard` discards anyway.
- **G6** — wider than described: the *structured* `model … invalid` pattern also matched the prose
  case, so it was split into a quoted form (scans everything) and an unquoted form + catch-all
  (error-ish lines only).
- **A1** — now fail-safe rather than fail-open: a mid-sentence "the change is APPROVED" yields
  `unknown` instead of `approved`. Note `unknown` remains non-blocking at the ship gate, exactly as
  before this change; only the prose false-positive is removed.

Known side effect: **E2** means every run with a dirty tree adds one `pre-run checkpoint` entry to
`git stash list`. That is the cost of making the snapshot gc-proof (it mirrors what
`extensions/revert.ts` already does for its own backup), but nothing prunes them.

### End-to-end verification

A real planner → implementer → reviewer run (no shipper, so no outward-facing action) against a
scratch project with a genuine failing test: plan written, one-line fix applied and committed on a
fresh `agent/<slug>` branch, reviewer APPROVED, 3/3 tests green, report + metrics written, 5m46s,
$0.032. Assertions: 8/8. Confirmed live —

- **A1** the real reviewer emitted both documented forms (`Verdict: APPROVED.` and a bare
  `APPROVED` under `## Verdict`); both still parse as `approved` under the stricter regex.
- **B1** a second run with a different request deleted run 1's `implementer`/`reviewer` sessions and
  recreated `planner.jsonl` under a NEW inode; that session contains exactly ONE user message, so no
  previous-run conversation was resumed. This is the bug's precise failure mode, now closed.
- **E1** `revertCommands` on the run's real checkpoint yields `["switch","--force","main"]` before
  `["reset","--hard",<sha>]` — while HEAD sat on the agent branch, which is the branch the old code
  would have force-rewritten.

G7's project-level `.env` precedence was NOT exercised end-to-end (the scratch project has no
`.env`); it rests on its unit tests.

---

## Cluster A — Review-gate integrity (HIGH, ship first)

Two independent bugs that compound: a reviewer's REVISE verdict can be misparsed as approved, and
even a correctly parsed REVISE never blocks shipping.

**A1. `detectCritique` matches the bare substring "approved" anywhere** — `utils/workflow/workflow-utils.ts:59-69`
The marker regex alternative `|APPROVED` has no word boundaries and is case-insensitive; any hit
skips the careful standalone-line fallback. "unapproved", "cannot be approved", or an explicit
`REVISE BEFORE MERGE` followed later by prose "…once fixed it can be approved" (last marker wins)
all yield `approved`. Consumer at `orchestrator-core.ts:729-730` then exits the fix loop.
- Fix: guard the bare-word alternatives with `(?<![A-Za-z])APPROVED(?![A-Za-z])` (same for
  `APPROVED WITH RESERVATIONS`), or require bare `APPROVED` standalone-on-a-line like the fallback
  already does. Keep the multi-word `REVISE BEFORE …` forms loose.
- Tests: "not approved", "unapproved", "REVISE BEFORE MERGE … can be approved later" → `revise`/non-approved.

**A2. Unresolved REVISE never blocks shipping when a shipper exists** — `utils/workflow/orchestrator-core.ts:845,857-869`
Ship gate is `if (passed && shipP)` where `passed` reflects only the validator (and defaults true
with none); the status ladder checks `else if (shipP)` before the `reviewVerdict === "revise"`
branch, making `needs-review` unreachable for any roster with a shipper. A run whose reviewer said
REVISE on every round still opens a PR and ends `shipped`.
- Fix: `const reviewOk = !reviewerP || reviewVerdict !== "revise"`; gate shipping on
  `passed && reviewOk && shipP`; add a `!reviewOk → "needs-review"` rung ahead of the `shipP` branch.
- Tests: roster [implementer, reviewer, shipper], reviewer exhausts the revise loop → no ship,
  status `needs-review` (currently only revise→approved is tested, orchestrator-core.test.ts:1787).

## Cluster B — Session lifecycle (HIGH)

**B1. Session wipe/TTL never touch the per-project subdirs — every run resumes the previous run's conversations** — `utils/workflow/workflow-core.ts:1547-1574`
`setupSessions` iterates only top-level `*.jsonl`, but `spawnAgentWithModel` writes sessions to
`<sessionDir>/<projectSessionHash(cwd)>/<agent>.jsonl` (workflow-core.ts:3245-3263) and passes `-c`
whenever the file exists (:3352). Pipeline phase keys are stable (`planner.jsonl`, …), so each new
`/agent-workflow` run resumes the previous request's context (contamination + inflated tokens) until
the 10MB "suspicious size" delete trips. TTL cleanup is equally dead → unbounded growth (confirmed:
months-old files on disk). Collateral: the wipe DOES delete top-level `dispatch-history.jsonl`
(dispatch.ts:127), erasing observability history it should keep.
- Fix: use the currently-unused `_cwd` param — wipe/TTL-clean `join(sessionDir, projectSessionHash(cwd))`
  (or recurse one level); exclude `dispatch-history.jsonl` from the top-level wipe.
- Tests: none exist for `setupSessions` — add wipe-hits-subdir, TTL-hits-subdir, history-file preserved.

## Cluster C — Event-stream & accounting correctness (workflow-core)

**C1. (MED-HIGH) `agent_end` double-counts usage and regresses final state** — `workflow-core.ts:3101-3184`
pi emits `message_end` per assistant message AND a final `agent_end` with the full messages array;
the handler treats both identically and on `agent_end` picks the FIRST assistant message. Result per
spawn: cost/output/cache tokens counted twice (cards, footer, report all doubled for single-turn
agents); `state.finalText` overwritten with the first turn's text; `phase.lastStopReason` overwritten
(masking `"length"`, which retry logic keys on at orchestrator-core.ts:1357,1552,1789).
- Fix: on `agent_end` use the LAST assistant message and skip the usage-accumulation block.
- Tests: feed `message_end` then `agent_end` (current tests feed only `message_end` sequences).

**C2. (MED) `phase.droppedLines` is dead code** — `workflow-core.ts:3466,3491` increment only
`state.droppedLines`; phase copy is only ever reset (2613,2650,2723), so the report's `[N dropped]`
marker and malformed-JSON diagnostic block (1831,1880-1885) can never fire.
- Fix: increment `phase.droppedLines` alongside, or sync state→phase in the close handler. Add a test.

**C3. (MED) Sticky `state.finalError` fails recovered spawns** — `workflow-core.ts:3118-3119,3212`
An assistant message with `stopReason: "error"` sets `finalError` forever; pi retries errored turns
internally, so a spawn that recovered and exited 0 is still forced to `exitCode: 1` (`[agent error]`),
triggering a full phase re-run or spurious model fallback.
- Fix: clear `finalError` when a later `message_end` arrives with a non-error stopReason.

**C4. (MED-LOW) Context % ignores cache tokens** — `workflow-core.ts:3162-3171`
Cache-heavy providers (prompt reported under `cacheRead`, `input: 0`) show ~0% context all run.
- Fix: compute occupancy from the last turn's `input + cacheRead + cacheWrite + output` (per-turn
  snapshot, not cumulative sums).

**C5. (LOW) Salvaged final stdout line drops a parseable `message_end`** — `workflow-core.ts:3479-3493`
Close-time leftover-buffer handling only salvages `text_delta`.
- Fix: route the parsed event through `handleSpawnEvent(event, state, phase, () => {})`.

## Cluster D — Dispatch/workflow mutual exclusion & abort safety (extensions)

**D1. (HIGH) The "cannot dispatch while a workflow runs" guard guards nothing since the tool split** — `extensions/dispatch.ts:72`, `orchestrator-core.ts:1397,1649,1856`
dispatch.ts keeps its own `newOrchestratorState()`; the core guards check only that local state,
which the workflow extension never sets (dispatch-events.ts:16-18's claimed mutual exclusion is
stale — pi runs tool batches in parallel). A dispatch mid-pipeline: the `DISPATCH_UPDATE` mirror
(agent-workflow.ts:1388-1398) clobbers `st.phases`/`st.dispatchMode` on every stream event, and the
dispatch's `commitStagedLearnings` (orchestrator-core.ts:1600) reads-and-clears `.agent/learnings.jsonl`
mid-run, breaking the verdict-gated commit. `__piHasRunningWorkflow` (agent-workflow.ts:1605-1606)
exists for exactly this and has zero consumers.
- Fix: dispatch guards consult `globalThis.__piHasRunningWorkflow?.()`; the mirror ignores
  `DISPATCH_UPDATE` while `st.running`; optionally mark the dispatch tools `executionMode: "sequential"`.

**D2. (MED) `DISPATCH_UPDATE` subscription leaks across `/reload`** — `agent-workflow.ts:1388`
The unsubscribe from `pi.events.on(...)` is discarded; the otherwise meticulous teardown
(:1675-1696) never removes it, and pi's event bus is process-lived across reloads → one stale
listener per reload mutating dead state and redrawing on a dead ctx.
- Fix: keep the unsubscribe and call it in `session_shutdown`.

**D3. (MED) Shared abort listener removed by the first finisher** — `dispatch.ts:259/272,318/330`
Both dispatch tools add/remove the SAME `killAllProcs` reference on the shared turn AbortSignal;
EventTarget dedupes, so the first tool to finish removes the only registration — aborting the turn
then orphans the other dispatch's child processes. Neither execute checks `signal.aborted` at entry.
- Fix: per-call listener closures + early `if (signal?.aborted) return`.

**D4. (LOW-MED) `host.signal` cleared without identity guard** — `agent-workflow.ts:1072-1075,1332-1336`
A second start refused by the core re-entry guard still clears the live run's signal in its finally
(and clobbers `st.activeTeamName` mid-run) → escape-cancel can no longer stop the pipeline.
- Fix: identity-guard `host.signal` clearing like `runAbort` already is; re-check `st.running` after
  the team-picker/input awaits.

**D5. (LOW) Object.prototype keys accepted as team names** — `agent-workflow.ts:365,997,1277`
`/agent-workflow constructor …` selects `Object.prototype.constructor`; `activeMembers()` then
throws inside the widget factory and the run ("… is not a function").
- Fix: `Object.hasOwn(st.teams, name) && Array.isArray(st.teams[name])` at the three lookup sites.

## Cluster E — Checkpoint/revert safety (support modules)

**E1. (MED) `/revert` resets whatever branch is current, not the checkpoint branch** — `checkpoint.ts:54-59`, `extensions/revert.ts:89`
Checkpoint taken on `main@abc`; run commits on `agent/<slug>`; `/revert` runs `reset --hard abc`
while still ON the agent branch — force-rewriting it (possibly with an open PR) to main's old tip.
- Fix: `revertCommands` prepends `["switch", cp.branch]` when `cp.branch` is a real branch (skip when
  detached/empty); the branch is already recorded for this.

**E2. (MED) Checkpoint snapshot is a dangling `stash create` sha — git gc can prune it** — `checkpoint.ts:44`, `agent-workflow.ts:242-246`
revert.ts:74-87 documents and mitigates this hazard for its own backup, but the pre-run snapshot is
never `stash store`d; after gc/2-week expiry, `stash apply <sha>` throws and pre-run uncommitted work
is unrecoverable.
- Fix: `git stash store -m "pre-run checkpoint" <sha>` when the snapshot is non-empty.

**E3. (MED) Detached HEAD treated as a user branch** — `checkpoint.ts:141-149`
`rev-parse --abbrev-ref HEAD` → literal `"HEAD"` → run commits detached; commits orphan on the next
checkout. Untested.
- Fix: treat `current === "HEAD"` as not-a-branch → create `agent/<slug>-<sha>` from the detached sha.
  Add a detached-HEAD test.

## Cluster F — Orchestrator robustness (medium/low)

**F1. (MED) Resume mode triggers for ANY planner-less roster** — `orchestrator-core.ts:523,578,650-661,982`
`.agent/plan.md` survives runs, so a reviewer-only team afterwards skips `resetRunScratch` (leaking
a crashed run's staged learnings into a verified commit) and adopts/validates the stale plan.
- Fix: `resuming = hasImplementer && !hasPlanner && hasExistingPlan`; clear `learnings.jsonl` even on
  resume. Test: planner-less non-build roster with leftover plan.md.

**F2. (MED) Thrown phase skips all terminal bookkeeping** — `orchestrator-core.ts:409-417`
No report, no metrics line, no obs verdict, staged learnings kept, widget left "running"; caller
(:222-231) still links the previous run's report.
- Fix: route the catch through `finalizeError` (guard for pre-init throws).

**F3. (MED) `dispatch_agent` head-only truncation drops the agent's conclusion** — `orchestrator-core.ts:1587-1590`
Agents summarize at the END; flat `slice(0, 8000)` discards it. `dispatchParallelCore` already uses
head+tail `clampOutput` (:1798).
- Fix: `clampOutput(res.output, 8000)`.

**F4. (MED) Empty-phase roster yields vacuous "done" and overwrites the previous report** — `workflow-core.ts:2547-2552` + orchestrator flow
- Fix: `finalizeError` with "this team has no pipeline roles" when `freshPhases` is empty.

**F5. (LOW) No per-item error isolation in parallel batch / single dispatch** — `orchestrator-core.ts:1768-1801,1522-1527`
One rejected spawn rejects `Promise.all`: siblings run detached, phases stuck "running", no
`dispatch_end`, batched learnings commit never runs.
- Fix: wrap each item in try/catch mapping throws to `{ output: String(e), exitCode: 1 }`.

**F6. (LOW) Cycle guard checks raw name pre-resolution** — `orchestrator-core.ts:1414-1420`
Alias dispatch evades the ancestry check (parallel path does it right at :1680).
- Fix: check after `resolveAgent` against `def.name.toLowerCase()`.

**F7. (LOW) Learnings-commit race between concurrent single dispatches** — `orchestrator-core.ts:1600`, `memory.ts:386-388`
Each finisher reads-AND-clears the shared staging file while a sibling may still be staging.
- Fix: active-dispatch counter on state; commit once at zero with the OR of verdicts (mirrors the
  parallel path's batching rationale at :1816-1820).

**F8. (LOW) Notify polish** — `orchestrator-core.ts:1584,1810-1812` pass `"success"` (SDK supports
info/warning/error per the file's own comment at :208-211) → use `"info"`. Re-entry-guard results
(:401-406) get a completion notice with stale elapsed time + a report link that run never wrote →
carry a `reportWritten` flag on RunResult and skip link/duration when false.

## Cluster G — Memory & parsing hygiene (low)

**G1. `remember` confirms lessons it will silently drop** — `extensions/agent-memory.ts:27-35`, `memory.ts:119`
Texts >280 chars are discarded at commit (`dedupeAppend`) after the tool replied "Saved…".
- Fix: enforce the cap in the tool's execute; return "too long — condense to one imperative sentence".

**G2. Memory writes are non-atomic and unlocked** — `memory.ts:274-281,396-406`
Crash mid-write truncates the file (tolerant parser then drops the tail forever); concurrent runs
share one repo-global dir.
- Fix (atomicity at least): write `<file>.tmp` + `renameSync`.

**G3. `parseMemory` meta regex eats lesson text from the first `<!--`** — `memory.ts:50,63-65`
A lesson containing an HTML comment loses everything after it on the next read-modify-write.
- Fix: locate the meta comment via `lastIndexOf("<!--")` (or greedy prefix), and/or strip `<!--`
  from staged text.

**G4. `parseTeamsYaml` turns `# comment:` lines into phantom teams** — `workflow-core.ts:1335`
- Fix: skip lines whose first non-space char is `#`; strip trailing comments from item lines.

**G5. CRLF agent/skill files silently fail frontmatter parsing** — `workflow-core.ts:1080,1395`
- Fix: `\r?\n` in the regexes; trim `\r` from values.

**G6. `isModelFailure` proximity catch-all misfires on domain prose** — `workflow-utils.ts:225-237`
"the data model is invalid" routes a logical failure to the fallback-model retry.
- Fix: require error-ish context (scan only lines matching `/error|failed|exception/i`) or drop the
  catch-all; add the negative test.

**G7. Project `.env` overrides the real shell env, contradicting the loader's doc** — `workflow-core.ts:254-257,283,313-315`
- Fix: let the project file override only keys the global `.env` itself set (snapshot pre-existing
  `process.env` keys), or fix the doc if shell-loses is intended.

**G8. Small ones** — pane debug log: `mkdirSync(dirname(logPath), {recursive:true})` before append
(`pane-mux.ts:264`); `/agent-workflow-clear` undone by the next `updateWidget()` — add a `cleared`
flag (`agent-workflow.ts:1088-1096,1406-1419,1547-1552`); dispatch.ts spawn wrapper missing the
`getFallbackContextWindow` hook that agent-workflow.ts wires (`dispatch.ts:156-174` vs
`agent-workflow.ts:816-829`) — copy it, and longer-term fold the two near-identical wrappers into one
shared helper.

---

## Verified-OK (checked, not bugs — don't "fix")

Phase-claiming in `dispatchAgentCore` is race-safe (synchronous before first await);
`PI_DISPATCH_MAX_DEPTH=0` honored; abort paths deliberately skip report writes (tested);
`renderCardGrid`/`renderPhaseCardsWithArrows` preconditions guaranteed by their call sites; pane-mux
quoting sound across tmux/wezterm/zellij/kitty/AppleScript; memory cap/eviction fixed and tested;
2KB session-header validation window sufficient; `killLiveProcs` SIGTERM→SIGKILL + unref'd timers
correct; globalThis bridge teardown identity-checked; `stageLearning` JSONL-injection-safe;
per-attempt token accumulation across transient retries intentionally counts real spend.
