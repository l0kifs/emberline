"""Cleanup applied to raw model output before it becomes ghost text.

FIM models routinely run past the useful completion and start re-emitting text
that already exists after the cursor. Rendering that produces visibly duplicated
code the moment the user accepts, so it has to be trimmed here rather than in the
extension -- the extension is deliberately dumb.
"""

from __future__ import annotations

_MAX_OVERLAP_SCAN = 200


def _strip_suffix_overlap(text: str, suffix: str) -> str:
    """Drop a tail of ``text`` that already appears at the head of ``suffix``.

    The classic case: cursor sits before ``)``, the model helpfully emits ``)``
    too, and accepting yields ``))``. Longest overlap wins.
    """
    if not text or not suffix:
        return text
    head = suffix[:_MAX_OVERLAP_SCAN]
    limit = min(len(text), len(head))
    for size in range(limit, 0, -1):
        if text[-size:] == head[:size]:
            return text[:-size]
    return text


def trim_completion(text: str, *, suffix: str = "") -> str:
    if not text:
        return ""

    # A completion that is only whitespace is noise; ghost text for it is worse
    # than nothing because it swallows the Tab key.
    if not text.strip():
        return ""

    text = _strip_suffix_overlap(text, suffix)

    # Trailing blank lines never help: the editor already has them, and they make
    # the ghost text render as an empty gap.
    text = text.rstrip("\n")
    if not text.strip():
        return ""

    return text
