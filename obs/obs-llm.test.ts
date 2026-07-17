import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { llmConfig, compactRun, parseResult, parseJudgement, explainRun, judgeRun, summarizeText, runPlayground, loadRepoEnv, piSpawnEnv, badCwd, type RunPi } from "./obs-llm";
import { dirname, delimiter } from "node:path";
import { buildRunDigest } from "./obs-explain";
import { makeFactory, type ObsEvent } from "./obs-events";

function fixtures(): ObsEvent[] {
    const f = makeFactory({ sessionId: "orch-1", agent: "orchestrator", runId: "run-x", cwd: "/home/me/proj" });
    return [
        f.next("session_start", { model: "claude-fable-5" }, 0),
        f.next("tool_start", { tool: "bash", toolCallId: "t1" }, 10),
        f.next("tool_end", { tool: "bash", toolCallId: "t1", isError: true, summary: "exit 1 — 1 failing", ms: 31700 }, 40),
        f.next("turn_end", { turnIndex: 0, tokens: { total: 12000 }, costUsd: 0.21 }, 60),
        f.next("dispatch_start", { agent: "reviewer", task: "review the diff" }, 70),
    ];
}

test("loadRepoEnv loads keys (strips inline comments), shell env still wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "obsenv-"));
    const f = join(dir, ".env");
    writeFileSync(
        f,
        ["# a comment", "PI_OBS_LLM=1", "PI_OBS_LLM_MODEL=anthropic/claude-haiku-4-5   # inline note", 'QUOTED="has space"', "ALREADY=fromfile"].join("\n"),
    );
    const env: NodeJS.ProcessEnv = { ALREADY: "fromshell" };
    loadRepoEnv(f, env);
    assert.equal(env.PI_OBS_LLM, "1");
    assert.equal(env.PI_OBS_LLM_MODEL, "anthropic/claude-haiku-4-5"); // inline comment stripped
    assert.equal(env.QUOTED, "has space");
    assert.equal(env.ALREADY, "fromshell"); // real env wins over the file
    // a missing file is a silent no-op
    loadRepoEnv(join(dir, "nope.env"), env);
});

test("summarizeText runs pi with the summary prompt and caches by content hash", async () => {
    const cfg = llmConfig({ PI_OBS_LLM: "1" });
    let calls = 0;
    let sawSystem = "";
    const fakePi: RunPi = async (_model, system, prompt) => {
        calls++;
        sawSystem = system;
        assert.match(prompt, /input of a tool call/);
        return "Fetches Jira ticket TTP-10962 via the atlassian CLI";
    };
    const r1 = await summarizeText("atlassian ticket TTP-10962 | jq …", "input", cfg, fakePi);
    assert.equal(r1.summary, "Fetches Jira ticket TTP-10962 via the atlassian CLI");
    assert.match(sawSystem, /ONE short, plain sentence/);
    assert.equal(r1.cached, undefined);
    const r2 = await summarizeText("atlassian ticket TTP-10962 | jq …", "input", cfg, fakePi);
    assert.equal(r2.cached, true); // same text+kind → cached, pi not re-invoked
    assert.equal(calls, 1);
});

test("llmConfig is off by default and resolves the model from env", () => {
    assert.equal(llmConfig({}).enabled, false);
    // explicit obs model wins
    assert.equal(llmConfig({ PI_OBS_LLM: "1", PI_OBS_LLM_MODEL: "anthropic/claude-opus-4-8" }).model, "anthropic/claude-opus-4-8");
    // else falls back to the workflow model
    assert.equal(llmConfig({ PI_OBS_LLM: "true", PI_WORKFLOW_MODEL: "gateframe/gpt-5-nano" }).model, "gateframe/gpt-5-nano");
    // else EMPTY → the pi spawn omits --model and inherits the primary session's model
    assert.equal(llmConfig({ PI_OBS_LLM: "1" }).model, "");
});

test("compactRun renders bounded facts from the digest", () => {
    const text = compactRun(buildRunDigest(fixtures()), fixtures());
    assert.match(text, /run run-x/);
    assert.match(text, /project proj/);
    assert.match(text, /tool errors/);
    assert.match(text, /bash/);
    assert.match(text, /notable events:/);
});

test("parseResult handles bare JSON, fenced JSON, and raw-text fallback", () => {
    assert.deepEqual(parseResult('{"narrative":"all good","recommendations":["x"]}'), {
        narrative: "all good",
        recommendations: ["x"],
    });
    assert.deepEqual(parseResult('```json\n{"narrative":"fenced","recommendations":[]}\n```'), {
        narrative: "fenced",
        recommendations: [],
    });
    assert.deepEqual(parseResult("just prose, no json"), { narrative: "just prose, no json", recommendations: [] });
});

test("runPlayground passes the system + input to pi and returns the output", async () => {
    const cfg = llmConfig({ PI_OBS_LLM: "1", PI_OBS_LLM_MODEL: "anthropic/claude-haiku-4-5" });
    let sawSystem = "";
    let sawPrompt = "";
    const fakePi: RunPi = async (_m, system, prompt) => {
        sawSystem = system;
        sawPrompt = prompt;
        return "  rewritten output  ";
    };
    const r = await runPlayground("Be terse.", "summarize this", cfg, fakePi);
    assert.equal(sawSystem, "Be terse.");
    assert.equal(sawPrompt, "summarize this");
    assert.equal(r.output, "rewritten output"); // trimmed
    assert.equal(r.model, "anthropic/claude-haiku-4-5");
    // empty system → a sane default is sent
    await runPlayground("", "x", cfg, fakePi);
    assert.match(sawSystem, /helpful assistant/);
});

test("parseJudgement clamps scores, keeps criteria, and falls back to their mean", () => {
    // explicit overall score + criteria; out-of-range scores get clamped
    const a = parseJudgement('{"score":120,"reason":"strong","criteria":[{"name":"goal_completion","score":90,"reason":"done"},{"name":"efficiency","score":-5,"reason":"pricey"}]}');
    assert.equal(a.score, 100); // clamped
    assert.equal(a.criteria.length, 2);
    assert.equal(a.criteria[1].score, 0); // clamped
    // no overall score → mean of criteria (80, 60 → 70)
    const b = parseJudgement('{"reason":"ok","criteria":[{"name":"a","score":80,"reason":""},{"name":"b","score":60,"reason":""}]}');
    assert.equal(b.score, 70);
    // garbage → safe default
    assert.deepEqual(parseJudgement("not json"), { score: 0, reason: "not json", criteria: [] });
});

test("judgeRun calls pi with the judge rubric and caches by runId+endTs", async () => {
    const digest = buildRunDigest(fixtures());
    const cfg = llmConfig({ PI_OBS_LLM: "1", PI_OBS_LLM_MODEL: "anthropic/claude-haiku-4-5" });
    let calls = 0;
    let sawSystem = "";
    const fakePi: RunPi = async (_model, system, prompt) => {
        calls++;
        sawSystem = system;
        assert.match(prompt, /run run-x/);
        return '{"score":72,"reason":"completed despite one tool error","criteria":[{"name":"goal_completion","score":85,"reason":"task done"},{"name":"error_handling","score":60,"reason":"one bash error"}]}';
    };
    const r1 = await judgeRun("run-x", digest, fixtures(), cfg, fakePi);
    assert.equal(r1.score, 72);
    assert.equal(r1.model, "anthropic/claude-haiku-4-5");
    assert.match(sawSystem, /LLM-as-judge/);
    assert.equal(r1.criteria[0].name, "goal_completion");
    assert.equal(r1.cached, undefined);
    const r2 = await judgeRun("run-x", digest, fixtures(), cfg, fakePi);
    assert.equal(r2.cached, true);
    assert.equal(calls, 1);
});

test("explainRun calls pi with the configured model and caches by runId+endTs", async () => {
    const digest = buildRunDigest(fixtures());
    const cfg = llmConfig({ PI_OBS_LLM: "1", PI_OBS_LLM_MODEL: "anthropic/claude-haiku-4-5" });
    let calls = 0;
    let sawModel = "";
    let sawSystem = "";
    const fakePi: RunPi = async (model, system, prompt) => {
        calls++;
        sawModel = model;
        sawSystem = system;
        assert.match(prompt, /run run-x/); // gets the compacted digest
        return '{"narrative":"the bash test failed once then the run continued","recommendations":["fix the flaky test"]}';
    };
    const r1 = await explainRun("run-x", digest, fixtures(), cfg, fakePi);
    assert.equal(r1.model, "anthropic/claude-haiku-4-5");
    assert.equal(sawModel, "anthropic/claude-haiku-4-5");
    assert.match(sawSystem, /ONLY a JSON object/);
    assert.equal(r1.recommendations[0], "fix the flaky test");
    assert.equal(r1.cached, undefined);
    // second call for the same runId+endTs is served from cache (pi not invoked)
    const r2 = await explainRun("run-x", digest, fixtures(), cfg, fakePi);
    assert.equal(r2.cached, true);
    assert.equal(calls, 1);
});

test("piSpawnEnv prepends node's bin dir so pi's shebang resolves", () => {
    const nodeDir = dirname(process.execPath);
    // A PATH missing node's dir (the detached-server case) gets it prepended.
    const withoutNode = piSpawnEnv({ PATH: "/usr/bin:/bin", FOO: "bar" });
    assert.equal(withoutNode.PATH!.split(delimiter)[0], nodeDir);
    assert.ok(withoutNode.PATH!.split(delimiter).includes("/usr/bin"));
    assert.equal(withoutNode.FOO, "bar"); // other env preserved
});

test("piSpawnEnv is idempotent when node's dir is already on PATH", () => {
    const nodeDir = dirname(process.execPath);
    const already = `${nodeDir}${delimiter}/usr/bin`;
    assert.equal(piSpawnEnv({ PATH: already }).PATH, already); // no duplicate entry
});

test("piSpawnEnv handles an empty/undefined PATH", () => {
    const nodeDir = dirname(process.execPath);
    assert.equal(piSpawnEnv({ PATH: "" }).PATH, nodeDir);
    assert.equal(piSpawnEnv({}).PATH, nodeDir);
});

test("badCwd flags a missing/invalid working directory, passes a real one", () => {
    assert.equal(badCwd(undefined), null); // unset ⇒ inherit server cwd
    assert.equal(badCwd(process.cwd()), null); // a real directory is fine
    const missing = badCwd("/no/such/dir/anywhere");
    assert.match(missing!, /does not exist/);
    assert.match(missing!, /PI_OBS_TG_CWD/); // points at the usual culprit
    // a path that exists but is a FILE, not a directory
    const notDir = badCwd(join(process.cwd(), "package.json"));
    assert.match(notDir!, /not a directory/);
});
