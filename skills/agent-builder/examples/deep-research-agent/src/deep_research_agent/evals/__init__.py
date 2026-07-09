"""Agent evaluation harness.

Run the agent against a file of eval cases and score the output with
deterministic checks and an optional LLM-as-judge, so agent quality can be
measured and regressions caught while iterating. See resources/docs/EVALS.md
for the methodology and the improve loop.
"""
