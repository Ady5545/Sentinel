# Humanizer

[![GitHub stars](https://img.shields.io/github/stars/blader/humanizer?style=flat)](https://github.com/blader/humanizer/stargazers) [![skills.sh installs](https://skills.sh/b/blader/humanizer)](https://skills.sh/blader/humanizer)

Humanizer makes AI-written text sound like a person wrote it, without changing what it says. It is built on Wikipedia's [Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) (WP:AISIGNS), and it works in Claude Code, Codex, Antigravity, and any other agent that supports skills.

**Before:**
> I'm thrilled to announce that shared drafts are finally here! 🚀 For months, our own team was drowning in files named final_v7.docx — and we knew there had to be a better way. Now two people can edit the same doc at once, with every change appearing live for both of them. It's not just a feature; it's a whole new way to collaborate. Comments stay anchored to the exact sentence they reference, even as the text around them evolves. And the best part? It's available today on every plan, completely free. Let that sink in.

**After:**
> Shared drafts are out today. For months our own team passed around files named final_v7.docx, so we built a way for two people to edit the same doc at once, with each person's changes showing up live for the other. Comments stay pinned to the sentence they're about, even when the text around them changes. It's free on every plan.

Humanizer edits for human readers. Getting past AI detectors is not a goal, and detectors still flag most of its output.

## Core principles

1. **Zero em dashes by default:** The Humanizer treats unnecessary em dashes (`—`) as a primary style issue, replacing them with periods, commas, colons, or parentheses, or splitting long clauses into two short sentences.
2. **Simple, natural English:** Everyday English is preferred over fancy synonyms, academic jargon, or wordy phrasing, while preserving technical accuracy.
3. **Pattern recognition over word blacklists:** A sentence is not AI-written just because it contains a formal word. Humanizer evaluates context, repetition, and rhythm.
4. **Factual accuracy:** Never invent facts, numbers, citations, quotes, or personal experiences.

## The five strongest tells

These are the most common signs of AI writing, and Humanizer rewrites any of them on sight:

1. **Not X but Y:** "It's not just a feature, it's a shift."
2. **One-line closers:** "Let that sink in."
3. **Sayings that sound deep:** "At its core, what really matters is..."
4. **A staged run-up:** "Here's the thing." "Honestly?"
5. **Arguing with no one:** "I'm not saying X, but..."

Humanizer checks for [32 patterns](#the-32-patterns) in all.

## Installation

Once installed, the skill answers to `/humanizer`.

### Claude Code

```text
/plugin marketplace add blader/humanizer
/plugin install humanizer@humanizer
```

### Codex

```bash
npx skills add blader/humanizer --global --agent codex
```

### Other agents

```bash
npx skills add blader/humanizer --global --agent '*'
```

## Usage

Call the skill directly:

```text
/humanizer

[paste your text here]
```

Or ask in plain language:

```text
Please humanize this text: [your text]
```

To rewrite a file, give Humanizer its path:

```text
Humanize the prose in docs/launch-post.md
```

### Match your voice

If you want the rewrite to sound more like you, include a sample:

```text
/humanizer

Here's a sample of my writing for voice matching:
[paste 2-3 paragraphs of your own writing]

Now humanize this text:
[paste AI text to humanize]
```

Humanizer follows the sample's rhythm, word choice, punctuation, and deliberate quirks.

## How it works

A language model writes whatever is most likely to come next, so by default it makes the choice that fits the widest range of readers and subjects. A person chooses for one reader and one subject. Every tell Humanizer looks for is a form of that default choice: a sentence that signals importance instead of adding a fact, rhythm or formatting applied by rule, an ordinary fact dressed as a pivotal one, text left over from the chat, or a reply that re-explains what the reader already knows.

Humanizer marks every tell it finds, strongest first. It drafts a rewrite without treating the original structure as fixed, checks the draft against the patterns and the original claims, and then writes the final version. It does not make things up. A name, number, date, quote, citation, or other factual detail must come from the source or the writer.

## The 32 patterns

The patterns are numbered by strength and frequency. The first five justify an edit on a single sighting. Patterns marked *weak alone* count only when several tells share a passage, because a careful writer may use any one of them on purpose.

### A. Staging instead of stating

| # | Pattern | Before | After |
|---|---------|--------|-------|
| 1 | **Not X but Y** | "It's not just X, it's Y", "This doesn't mean X. It means Y." | State the point directly |
| 2 | **One-line closers and dramatic fragments** | "That is the real win." after every section; "This shows the importance of..." after an example; "No prior. No nostalgia." | Cut the closer that repeats or explains the example; merge fragments into a specific claim |
| 3 | **Sayings that sound deep** | "At its core, what matters is...", "Symmetry is the language of trust" | Replace the saying with the specific claim |
| 4 | **Staged run-up before the point** | "Let's dive in", "Honestly? It depends..." | Remove the run-up and state the point |
| 5 | **Arguing with no one** | "This isn't mainly about...", "A tempting approach would be..." | Remove the unraised objection or fake option; keep any real claim |

### B. Rhythm and punctuation by rule

| # | Pattern | Before | After |
|---|---------|--------|-------|
| 6 | **Forced triads** | "innovation, inspiration, and insights"; three examples plus a lesson | Use the number of items the meaning needs |
| 7 | **Repeated sentence openings** | "She noted... She noted... She filed..." | Merge the sentences or change the subject |
| 8 | **Dashes as the universal connector** | "institutions—not the people—yet this continues—" | Use periods, commas, colons, or parentheses; zero em dashes by default |
| 9 | **Stacked qualifiers** (*weak alone*) | "could potentially possibly be argued" | Keep only qualifiers the source supports |
| 10 | **Hyphenated pairs everywhere** (*weak alone*) | "the report is high-quality" | Keep the hyphen before the noun or where the dictionary has one |
| 11 | **Passive voice and missing subjects** (*weak alone*) | "No configuration file needed" | Name the actor when that helps |

### C. Inflation and borrowed authority

| # | Pattern | Before | After |
|---|---------|--------|-------|
| 12 | **Overused AI words** | "delve... testament... landscape... showcasing" | Use plain words |
| 13 | **Inflated significance and generic send-offs** | "marking a pivotal moment", "Despite challenges... continues to thrive", "The future looks bright" | Keep the fact and drop the significance; end on the last concrete fact |
| 14 | **Vague connection or association** | "associated with the leadership of", "in connection with" | State the relationship the source gives |
| 15 | **Shallow -ing riders** | "symbolizing... reflecting... showcasing..." | Keep only what the source supports |
| 16 | **Sales language and generic superlatives** | "nestled within the breathtaking region" | State what the thing is |
| 17 | **Borrowed authority and vague attribution** | "Experts believe...", "cited in NYT, BBC, FT, and The Hindu" | Name a real source and what it said, or remove the claim or list |
| 18 | **Avoiding is, are, and has** | "serves as... features... boasts" | "is... has" |
| 19 | **False ranges** | "ranging from technical expertise to creative vision" | State the distinct items or actual range |
| 20 | **Compulsive summaries and wrap-ups** | "In conclusion...", "Overall, taking everything into account..." | Cut redundant recaps; end on the last concrete fact |
| 21 | **Superficial balance** | "While some argue X, others believe Y, and each perspective has merit" | State specific differences or empirical trade-offs |
| 22 | **Canned notability and media coverage emphasis** | "garnered independent coverage in leading publications", "maintains an active social media presence" | Summarize the actual coverage or remove empty metadata |

### D. Formatting and presentation by rule

| # | Pattern | Before | After |
|---|---------|--------|-------|
| 23 | **Bold as decoration** | "**OKRs**, **KPIs**"; "**Performance:** Performance improved" | Remove the bold; turn a labeled list into prose |
| 24 | **Decorative headings and emoji clutter** | "Strategic Negotiations And Partnerships", "🚀 Launch Phase:", "The decision, on one screen" | Sentence case; remove emojis and arrows; name what the section holds |
| 25 | **Curly quotation marks** (*weak alone*) | `said “the project”` | `said "the project"` |
| 26 | **Table and formatting misuse** | Minimal 2-column tables for simple points; markdown tables in wikitext | Convert to prose or structured lists |

### E. Leftovers from chat, draft, and models

| # | Pattern | Before | After |
|---|---------|--------|-------|
| 27 | **Chatbot residue** | "Great question! ... I hope this helps!" | Remove the wrapper and keep the content |
| 28 | **Hedging disclaimers and speculative gap-filling** | "While details are not publicly available, it appears...", "keeps personal life private" | State verified facts or omit the speculation entirely |
| 29 | **Self-conscious policy and procedural assurances** | "Revised for clarity and neutrality per guidelines while preserving technical details" | State what was changed directly; omit what was avoided or compliance posturing |
| 30 | **Phrasal templates and placeholder tokens** | "[Entertainer's Name]", "2025-xx-xx", "Delete this section before submission" | Fill with real data or remove |
| 31 | **Exposed citations and tracker parameters** | "contentReference[oaicite:1]", "?utm_source=chatgpt.com", "<mark>text</mark>" | Strip tracking parameters and clean citation tokens |
| 32 | **Writing about the document instead of its subject** | "This function was added to replace...", "compiled from...", "The table below compares..." | Describe the subject; state a convention only when the reader cannot see it |

## Sources

- [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) (WP:AISIGNS), maintained by WikiProject AI Cleanup.
- [Wikipedia: Signs of AI use in comments](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_use_in_comments) (WP:AICOMMENT).

## Version history

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
