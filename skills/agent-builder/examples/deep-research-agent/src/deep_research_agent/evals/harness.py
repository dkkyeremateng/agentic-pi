"""Eval runner: run the agent against a case file, score it, report.

Usage:
    deep-research-agent-eval cases.yaml
    deep-research-agent-eval cases.yaml --out results.json --no-judge

A case file is a YAML or JSON list of cases:

    - name: greeting
      prompt: "Reply with a single greeting word."
      checks:
        - {type: no_error}
        - {type: max_length, value: 40}
      judge:
        rubric: "The reply is a single friendly greeting word."
        min_score: 4

Heavy imports (the graph, the model, yaml) are loaded lazily so the pure
scoring/reporting logic stays importable and testable on its own.
"""

import argparse
import json
import sys

from deep_research_agent.evals.scorers import run_check
from deep_research_agent.evals.judge import judge_output


def load_cases(path: str) -> list:
    """Load cases from a YAML (.yaml/.yml) or JSON file."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if path.endswith((".yaml", ".yml")):
        import yaml
        return yaml.safe_load(text) or []
    return json.loads(text) or []


def run_agent_case(graph, prompt: str, thread_id: str) -> dict:
    """Run one prompt through the compiled graph and capture what evals need."""
    from deep_research_agent.config import get_recursion_limit
    tools, error, output = [], None, ""
    try:
        state = graph.invoke(
            {"messages": [{"role": "user", "content": prompt}]},
            config={
                "configurable": {"thread_id": thread_id},
                "recursion_limit": get_recursion_limit(),
            },
        )
        messages = state.get("messages", []) if isinstance(state, dict) else []
        for msg in messages:
            for tc in getattr(msg, "tool_calls", None) or []:
                tools.append(tc.get("name"))
        if messages:
            output = str(getattr(messages[-1], "content", "") or "")
    except Exception as e:
        error = str(e)
    return {"output": output, "tools": tools, "error": error}


def evaluate(cases: list, graph, use_judge: bool = True) -> list:
    """Run and score every case. Returns a list of per-case result dicts."""
    results = []
    for i, case in enumerate(cases):
        name = case.get("name", f"case-{i}")
        run = run_agent_case(graph, case.get("prompt", ""), f"eval-{i}-{name}")
        checks = [run_check(run, c) for c in case.get("checks", [])]

        judged = None
        if use_judge and case.get("judge"):
            spec = case["judge"]
            judged = judge_output(case.get("prompt", ""), run["output"],
                                  spec.get("rubric", ""))
            judged["min_score"] = int(spec.get("min_score", 4))
            judged["passed"] = judged["score"] >= judged["min_score"]

        passed = all(c.passed for c in checks) and (
            judged["passed"] if judged else True
        )
        results.append({
            "name": name,
            "passed": passed,
            "run": run,
            "checks": [c.__dict__ for c in checks],
            "judge": judged,
        })
    return results


def report(results: list) -> str:
    """Render a text report; failures list which checks failed."""
    total = len(results)
    passed = sum(1 for r in results if r["passed"])
    lines = []
    for r in results:
        lines.append(f"[{'PASS' if r['passed'] else 'FAIL'}] {r['name']}")
        if not r["passed"]:
            for c in r["checks"]:
                if not c["passed"]:
                    lines.append(f"    - check {c['type']}: {c['detail']}")
            if r["run"]["error"]:
                lines.append(f"    - error: {r['run']['error']}")
            if r["judge"] and not r["judge"]["passed"]:
                j = r["judge"]
                lines.append(
                    f"    - judge {j['score']}/{j['min_score']}: {j['reason']}"
                )
    scores = [r["judge"]["score"] for r in results if r.get("judge")]
    avg = f", avg judge {sum(scores) / len(scores):.1f}/5" if scores else ""
    lines.append("")
    lines.append(f"{passed}/{total} passed{avg}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate the agent against a YAML/JSON case file."
    )
    parser.add_argument("cases", help="Path to the eval case file")
    parser.add_argument("--out", help="Write the full results JSON here")
    parser.add_argument("--no-judge", action="store_true",
                        help="Skip LLM-as-judge checks (deterministic only)")
    args = parser.parse_args()

    from deep_research_agent.app import build_graph
    cases = load_cases(args.cases)
    if not cases:
        print("No cases found.")
        return 1
    graph = build_graph()
    results = evaluate(cases, graph, use_judge=not args.no_judge)
    print(report(results))
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2, default=str)
    return 0 if all(r["passed"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
