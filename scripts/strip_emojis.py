#!/usr/bin/env python3
"""
strip_emojis.py — remove emoji characters from markdown files.

Reads a file, removes every emoji character (plus variation selectors and
zero-width joiners), cleans up the whitespace artifacts that get left
behind (trailing spaces, doubled spaces, table-cell leading spaces),
and writes the result back (or to a new path with --to).

Usage:
    python3 scripts/strip_emojis.py path/to/file.md
    python3 scripts/strip_emojis.py path/to/file.md --to path/to/new.md
    python3 scripts/strip_emojis.py --check path/to/file.md   # dry-run, exit 1 if emojis found

This is the canonical emoji-stripping utility for the no-emoji house rule
documented in /docs/conventions/LABELS.md. Run on any markdown file
before committing to verify it's clean.
"""
from __future__ import annotations
import argparse
import re
import sys
from pathlib import Path


# Unicode ranges covering the emoji blocks that show up in our docs.
# Inclusive ranges. Order doesn't matter; regex compiles them as a charset.
EMOJI_RANGES = [
    (0x1F600, 0x1F64F),  # emoticons
    (0x1F300, 0x1F5FF),  # misc symbols & pictographs
    (0x1F680, 0x1F6FF),  # transport & map symbols
    (0x1F700, 0x1F77F),  # alchemical
    (0x1F780, 0x1F7FF),  # geometric shapes extended
    (0x1F800, 0x1F8FF),  # supplemental arrows C
    (0x1F900, 0x1F9FF),  # supplemental symbols and pictographs
    (0x1FA00, 0x1FA6F),  # chess
    (0x1FA70, 0x1FAFF),  # symbols and pictographs extended-A
    (0x2600,  0x26FF),   # misc symbols (includes the eye-watering and the colored dots)
    (0x2700,  0x27BF),   # dingbats (includes check marks)
    (0x2300,  0x23FF),   # misc technical
    (0x25A0,  0x25FF),   # geometric shapes
    (0x2B00,  0x2BFF),   # misc symbols and arrows
    (0x1F1E0, 0x1F1FF),  # flags
]
# Single codepoints that aren't full ranges but should still go:
EMOJI_SINGLES = [
    0xFE0F,   # variation selector-16 (the "emoji presentation" modifier)
    0xFE0E,   # variation selector-15 (text presentation modifier)
    0x200D,   # zero-width joiner
    0x20E3,   # combining enclosing keycap
]


def _build_emoji_re() -> re.Pattern:
    parts = []
    for lo, hi in EMOJI_RANGES:
        parts.append(f"\\U{lo:08X}-\\U{hi:08X}")
    for cp in EMOJI_SINGLES:
        parts.append(f"\\U{cp:08X}")
    pattern = "[" + "".join(parts) + "]"
    return re.compile(pattern, flags=re.UNICODE)


EMOJI_RE = _build_emoji_re()


def strip(content: str) -> tuple[str, int]:
    """Strip emojis. Returns (cleaned, count_removed)."""
    count = len(EMOJI_RE.findall(content))
    if count == 0:
        return content, 0

    cleaned = EMOJI_RE.sub("", content)

    # Clean up artifacts left behind by removal:
    # - trailing whitespace on every line
    cleaned = re.sub(r"[ \t]+$", "", cleaned, flags=re.MULTILINE)
    # - double-spaces collapsed to single (but not in code blocks; this is a
    #   simple heuristic — markdown code blocks should be rare in our docs
    #   and double spaces inside them are still legal markdown)
    cleaned = re.sub(r"  +", " ", cleaned)
    # - lines that become just " | " or "| |" in tables: leave for human cleanup
    # - leading space inside table cells like "| Vac |" if the emoji was
    #   followed by content "| 📥 Vac |" → "|  Vac |" → "| Vac |"
    cleaned = re.sub(r"\|\s+", "| ", cleaned)
    cleaned = re.sub(r"\s+\|", " |", cleaned)

    return cleaned, count


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("path", help="markdown file to strip")
    ap.add_argument("--to", help="write to this path instead of in-place")
    ap.add_argument("--check", action="store_true",
                    help="dry-run; exit 1 if any emojis present")
    args = ap.parse_args()

    src = Path(args.path)
    if not src.exists():
        print(f"error: {src} does not exist", file=sys.stderr)
        return 2

    text = src.read_text(encoding="utf-8")
    cleaned, count = strip(text)

    if args.check:
        if count > 0:
            print(f"FAIL {src}: {count} emoji codepoint(s) found")
            return 1
        print(f"OK   {src}: clean")
        return 0

    dst = Path(args.to) if args.to else src
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(cleaned, encoding="utf-8")
    print(f"stripped {count} emoji codepoint(s): {src} -> {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
