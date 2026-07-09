"""Output truncation — keep tool results from flooding the model's context.

A single large file read or directory listing can blow the context window and
crowd out the conversation. Every tool that returns free-form text should pass
its result through ``truncate_output`` so oversized output is clipped with an
explicit marker rather than dumped whole.
"""

DEFAULT_MAX_LINES = 400
DEFAULT_MAX_CHARS = 20_000


def truncate_output(
    text: str,
    max_lines: int = DEFAULT_MAX_LINES,
    max_chars: int = DEFAULT_MAX_CHARS,
) -> str:
    """Bound ``text`` to ``max_lines`` and ``max_chars``, whichever hits first.

    Appends a one-line marker noting the limits when anything was clipped so
    the model knows the result is partial and can narrow its next request.
    """
    if not text:
        return text or ""

    clipped = False

    lines = text.splitlines()
    if len(lines) > max_lines:
        text = "\n".join(lines[:max_lines])
        clipped = True

    if len(text) > max_chars:
        text = text[:max_chars]
        clipped = True

    if clipped:
        text += f"\n... [output truncated to {max_lines} lines / {max_chars} chars]"
    return text
