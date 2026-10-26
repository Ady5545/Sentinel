# Contributing to Bug Hunt

Thanks for your interest in contributing! This is a small project (a Claude Code skill with 3 agent prompts), so the process is lightweight.

## What we welcome

- Prompt improvements (better bug detection, fewer false positives)
- New agent ideas or workflow changes
- Documentation fixes and improvements
- Bug reports and feature requests

## Getting started

1. Fork the repo and clone it:
   ```bash
   git clone https://github.com/<your-username>/bug-hunt.git ~/.claude/skills/bug-hunt
   ```

2. Make your changes.

3. Test locally by running `/bug-hunt` in Claude Code against a real codebase. There's no automated test suite — the skill is tested by using it.

4. Open a PR.

## PR guidelines

- Describe **what** changed and **why**
- Explain **how you tested** (e.g., "Ran `/bug-hunt src/` on project X, verified the referee output improved")
- Keep changes focused — one concern per PR

## Reporting issues

Use the [GitHub issue templates](https://github.com/danpeg/bug-hunt/issues/new/choose) for bug reports and feature requests.

## Code of Conduct

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.
