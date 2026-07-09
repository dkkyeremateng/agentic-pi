"""Approximate token pricing for the footer's running cost estimate.

Prices are USD per 1M tokens and are intentionally a small, best-effort table
— provider pricing changes often and there are many providers. A model with no
entry simply shows token counts with no cost (``estimate_cost`` returns None).

Override or extend at runtime with the PI_TUI_PRICES env var, a comma list of
``model_substr:in_per_m/out_per_m`` items, e.g.
``PI_TUI_PRICES=my-model:3/15,other:0.5/1.5``.
"""

import os

# model-name substring -> (input $/1M, output $/1M)
_PRICES: dict[str, tuple[float, float]] = {
    "claude-opus": (5.0, 25.0),
    "claude-sonnet": (3.0, 15.0),
    "claude-haiku": (1.0, 5.0),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (2.5, 10.0),
    "gpt-4.1": (2.0, 8.0),
    "o3": (2.0, 8.0),
}


def _env_prices() -> dict[str, tuple[float, float]]:
    raw = os.environ.get("PI_TUI_PRICES", "").strip()
    if not raw:
        return {}
    out: dict[str, tuple[float, float]] = {}
    for item in raw.split(","):
        item = item.strip()
        if not item or ":" not in item or "/" not in item:
            continue
        name, rates = item.split(":", 1)
        inp, outp = rates.split("/", 1)
        try:
            out[name.strip()] = (float(inp), float(outp))
        except ValueError:
            continue
    return out


def estimate_cost(model: str, input_tokens: int, output_tokens: int):
    """Return an estimated USD cost, or None if the model has no known price."""
    table = {**_PRICES, **_env_prices()}
    model = (model or "").lower()
    match = next((rates for name, rates in table.items() if name in model), None)
    if match is None:
        return None
    in_rate, out_rate = match
    return (input_tokens / 1_000_000) * in_rate + (output_tokens / 1_000_000) * out_rate
