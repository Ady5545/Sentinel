# Changelog

## 4.1.0

- Integrated latest Wikipedia WP:AISIGNS and WP:AICOMMENT field research (October 2026 update).
- Expanded pattern directory to 32 numbered patterns:
  - Added #22: Canned notability and media coverage emphasis (*"independent coverage in regional/national outlets"*, *"maintains an active social media presence"*).
  - Added #26: Table and formatting misuse (small 2-column tables that should be prose, markdown tables inside wikitext).
  - Added #29: Self-conscious policy and procedural assurances (edit summaries or text boasting of compliance with neutrality/style guidelines while claiming to "preserve" details).
  - Added #30: Phrasal templates and placeholder tokens (*[Entertainer's Name]*, *2025-xx-xx*, *Delete before submitting*).
  - Added #31: Exposed citations and tracker parameters (`contentReference[oaicite:1]`, `?utm_source=chatgpt.com`, `utm_source=openai`, `utm_source=copilot.com`, `referrer=grok.com`, `<mark>` tags).
- Updated #1 to include Y-rather-than-X contrast inversions.
- Updated #8 (em dashes) to warn against the counter-extreme of reactionary monotone cadence (monotonous 8–20 word comma-period clauses).
- Updated #18 to catch *refers to* definition constructs.
- Updated all manifests (`SKILL.md`, `README.md`, `plugin.json`, `marketplace.json`, `cursor-plugin/plugin.json`) and test suites to v4.1.0.

## 4.0.0

- Upgraded Humanizer with core priorities for em dash elimination and simple, natural English by default.
- Added Priority 1: Zero em dashes by default. Humanized output must contain no em dashes (—) unless protected in quotes, code, or requested. Unnecessary dashes are replaced with periods, commas, colons, or parentheses, or split into two sentences.
- Added Priority 2: Simple, natural English by default. Prefers common words, active voice, and short sentences over fancy, academic, or formal jargon while keeping technical precision.
- Added Priority 3: Detect patterns in context rather than relying on isolated word blacklists.
- Expanded the AI writing catalog to 28 patterns, incorporating Wikipedia WP:AISIGNS: added #19 False ranges, #20 Compulsive summaries and wrap-ups, #21 Superficial balance, and tightened sales language, borrowed authority, and bold labeling.
- Updated all plugin manifests and test suites to v4.0.0.

## 3.1.0

- Added pattern #26 and section F for replies that re-explain context the reader already has (#269). It acts on replies, not standalone writing. 26 patterns total.
- Extended the core rule so "something the reader did not already have" counts the surrounding conversation, not only earlier text.
- Widened #25 to text that describes its own sourcing, assembly, or layout (#290), and added headings written for effect to #20.
- Extended #2 to "That distinction matters." (#277) and to a sentence that explains what an example already showed (#295).
- Narrowed #10 so words the dictionary always hyphenates keep their hyphen. Gave each watched word one pattern, and stated the evidence rule and the no-invention rule once each.
- Fixed the Voice section's dash reference (#273) and the marketplace schema URL (#288).
- Added a Cursor plugin manifest (#278).
- README: opens with a before/after, the five strongest tells, and install steps for each agent. States that getting past AI detectors is not a goal. The full example's rewrite now keeps every fact from its draft and adds none. Version history moved to this file.
