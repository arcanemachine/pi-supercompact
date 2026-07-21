# Changelog

## Unreleased

- Add an agent-callable `supercompact` tool with one-shot and session authorization gates.
- Add `/supercompact` menu and explicit `run`, `allow`, `enable`, and `disable` subcommands.
- Add global and trusted-project configuration for the default agent-tool state.
- Defer one-shot tool removal until the workflow settles to reduce prompt-cache churn.
- Preserve established non-obvious constraints and source-of-truth decisions across continuation.
- Keep resumed next actions subordinate to recorded scope and responsibility boundaries.

## 0.1.0 - 2026-07-19

- Add `/supercompact [extra context]`.
- Queue full-context summarization as steering work.
- Run native Pi compaction and restore a continuation-aware context summary.
- Record continuation with a temporary schema-validated tool while keeping the summary as ordinary Markdown.
- Retain only the newest hidden super-summary and filter completed internal metadata artifacts from model context.
- Add bounded decision retries, targeted file-reread guidance, working messages, and decision-specific notifications.
