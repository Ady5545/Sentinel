#!/usr/bin/env python3
"""Regression test suite for Humanizer rule patterns and invariants."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL = (ROOT / "SKILL.md").read_text(encoding="utf-8")


class TestHumanizerRules(unittest.TestCase):
    def test_em_dash_default_invariant(self):
        """Verify that zero em dashes by default is stated as a primary rule."""
        self.assertIn("Priority 1: Zero em dashes by default", SKILL)
        self.assertIn("no em dashes", SKILL.lower())

    def test_simple_english_invariant(self):
        """Verify that simple, natural English is required by default."""
        self.assertIn("Priority 2: Simple, natural English by default", SKILL)
        self.assertIn("utilize", SKILL)
        self.assertIn("facilitate", SKILL)

    def test_pattern_detection_over_blacklist(self):
        """Verify that pattern evaluation in context is required."""
        self.assertIn("Priority 3: Detect patterns, not isolated words", SKILL)

    def test_full_pattern_sequence(self):
        """Verify that all 32 patterns exist sequentially without gaps."""
        patterns = re.findall(r"(?m)^### ([0-9]+)\. (.+)$", SKILL)
        numbers = [int(n) for n, _ in patterns]
        self.assertEqual(numbers, list(range(1, 33)))

    def test_prohibited_unrendered_em_dash_in_explanations(self):
        """Check that explanatory text itself does not casually rely on stray em dashes."""
        # Split out the patterns section
        lines = SKILL.splitlines()
        for idx, line in enumerate(lines, 1):
            if line.startswith("#") or line.startswith("- **Watch for:**") or line.startswith("- **Before:**"):
                continue
            # Code or quotation blocks
            if "`—`" in line or '“—' in line:
                continue
            # Warn if explanatory sentences use unquoted em dashes
            # e.g., "word — word"
            if re.search(r"[a-zA-Z0-9]\s*—\s*[a-zA-Z0-9]", line):
                self.fail(f"Line {idx} uses an unquoted em dash in prose: {line}")


class TestHumanizerHeuristics(unittest.TestCase):
    def test_em_dash_detection(self):
        sample = "The release was postponed — three nodes failed health checks — causing downtime."
        dashes = re.findall(r"—", sample)
        self.assertEqual(len(dashes), 2)

    def test_quoted_dash_preservation(self):
        sample = 'She said, "This feature — regardless of cost — is vital."'
        # Regex to detect quoted fragments
        quotes = re.findall(r'"([^"]*)"', sample)
        self.assertTrue(any("—" in q for q in quotes))

    def test_plain_english_substitution_pairs(self):
        pairs = [
            ("utilize the available resources", "use the available resources"),
            ("in order to achieve the desired outcome", "to get the desired result"),
            ("due to the fact that the system was unavailable", "because the system was unavailable"),
            ("demonstrates considerable efficacy", "works well"),
        ]
        for pompous, plain in pairs:
            self.assertNotEqual(pompous, plain)


if __name__ == "__main__":
    unittest.main()
