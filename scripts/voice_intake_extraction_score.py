#!/usr/bin/env python3
"""
MOD Catalogue Raisonné — Voice Form Entry extraction, v1 (test set + scorer).

First deliverable of the "Voice Form Entry: Field Value Extraction Fix" spec
(see ROADMAP.md item 3). Ground rule for this item: prove the failure with a
real test set before writing any fix -- this script does exactly that, and
nothing else. It does not touch the live intake form or any Supabase data.

What's actually broken, confirmed by reading the live code (viApplyTranscriptToField
in HTMLs/catalogue_intake_v127_sans.html): the voice intake flow transcribes
speech (agent-transcribe), reads the raw transcript back for a yes/no
confirmation, and on "yes" stores it completely verbatim --

    el.value = text;

-- with zero extraction. A spoken lead-in ("The title is Faucet") is stored
as literally "The title is Faucet" instead of "Faucet". This script encodes
that exact current behavior (a pure passthrough) and scores it against
voice_intake_extraction_testset.json, a hand-built set of realistic spoken
answers per field type (title, date, dimensions, medium, notes) covering
bare values, formal and casual lead-ins, self-corrections, and two edge
cases a naive string-stripping fix could get wrong: a real catalogued value
that legitimately starts with "The", and one that legitimately contains the
word "is" (so a future fix must extract meaning, not just regex away
"the ... is" / "it's" prefixes).

Usage:
    python3 voice_intake_extraction_score.py
    python3 voice_intake_extraction_score.py --verbose   # show every case, not just failures
"""

import argparse
import json
from pathlib import Path

TESTSET_PATH = Path(__file__).parent / "voice_intake_extraction_testset.json"


def current_behavior(transcript: str) -> str:
    """Exactly what viApplyTranscriptToField does today: el.value = text."""
    return transcript


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verbose", action="store_true", help="Show every case, not just failures.")
    args = parser.parse_args()

    cases = json.loads(TESTSET_PATH.read_text())

    results = []
    for c in cases:
        actual = current_behavior(c["transcript"])
        passed = actual == c["expected"]
        results.append({**c, "actual": actual, "passed": passed})

    total = len(results)
    passed_count = sum(1 for r in results if r["passed"])
    failed_count = total - passed_count

    print(f"Voice intake extraction -- current behavior vs. expected clean value")
    print(f"{'=' * 70}")

    for r in results:
        if r["passed"] and not args.verbose:
            continue
        status = "PASS" if r["passed"] else "FAIL"
        print(f"[{status}] {r['field']} / {r['case_type']}")
        print(f"       spoken:   {r['transcript']!r}")
        print(f"       expected: {r['expected']!r}")
        if not r["passed"]:
            print(f"       stored:   {r['actual']!r}")
        print()

    # Breakdown by field and by case type -- a flat pass/fail count alone
    # doesn't show WHERE the failure concentrates, which matters for scoping
    # v2's fix (e.g. if corrections fail differently than plain lead-ins).
    by_field = {}
    by_case_type = {}
    for r in results:
        by_field.setdefault(r["field"], [0, 0])
        by_case_type.setdefault(r["case_type"], [0, 0])
        idx = 0 if r["passed"] else 1
        by_field[r["field"]][idx] += 1
        by_case_type[r["case_type"]][idx] += 1

    print(f"{'=' * 70}")
    print("By field:")
    for field, (p, f) in sorted(by_field.items()):
        print(f"  {field:12s}  {p} passed / {f} failed  (of {p + f})")

    print("\nBy case type:")
    for case_type, (p, f) in sorted(by_case_type.items()):
        print(f"  {case_type:24s}  {p} passed / {f} failed  (of {p + f})")

    print(f"\n{'=' * 70}")
    print(f"TOTAL: {passed_count} passed / {failed_count} failed (of {total})")
    print(f"Current behavior's real accuracy: {passed_count / total:.0%}")


if __name__ == "__main__":
    main()
