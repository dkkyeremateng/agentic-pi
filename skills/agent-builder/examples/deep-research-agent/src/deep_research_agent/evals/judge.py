"""LLM-as-judge scoring for eval cases (provider-agnostic).

Use for qualities that deterministic checks cannot express — tone, correctness,
completeness, whether an answer actually addresses the question. The judge
returns a 1-5 score and a one-line reason.

The model factory is imported lazily so this module stays importable (and the
parser stays unit-testable) without a provider configured.
"""

import re

JUDGE_SYSTEM = (
    "You are a strict evaluator. Score how well the ASSISTANT OUTPUT satisfies "
    "the RUBRIC, on a scale of 1 to 5 (5 = fully satisfies, 1 = does not). "
    "Respond with EXACTLY two lines:\n"
    "SCORE: <1-5>\n"
    "REASON: <one sentence>"
)


def parse_judgement(text: str) -> dict:
    """Parse a judge reply into {"score": int, "reason": str}.

    Tolerant: falls back to the first digit 1-5 found, and to the whole reply as
    the reason. Returns score 0 when no score can be found.
    """
    text = str(text or "")
    m = re.search(r"SCORE:\s*([1-5])", text, re.IGNORECASE)
    if not m:
        m = re.search(r"\b([1-5])\b", text)
    score = int(m.group(1)) if m else 0
    rm = re.search(r"REASON:\s*(.+)", text, re.IGNORECASE | re.DOTALL)
    reason = (rm.group(1) if rm else text).strip().replace("\n", " ")[:200]
    return {"score": score, "reason": reason}


def judge_output(prompt: str, output: str, rubric: str, model=None) -> dict:
    """Score `output` against `rubric`. Returns {"score", "reason"}."""
    if model is None:
        from deep_research_agent.config import create_model
        model = create_model()
    user = (
        f"RUBRIC:\n{rubric}\n\n"
        f"USER PROMPT:\n{prompt}\n\n"
        f"ASSISTANT OUTPUT:\n{output}"
    )
    try:
        resp = model.invoke([
            {"role": "system", "content": JUDGE_SYSTEM},
            {"role": "user", "content": user},
        ])
    except Exception as e:
        return {"score": 0, "reason": f"judge call failed: {e}"}
    return parse_judgement(str(getattr(resp, "content", "") or ""))
