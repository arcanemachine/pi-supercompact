# Changelog

## Unreleased

- Change `/supercompact run` into a focused pre-compaction preparation and wrap workflow.
- Add `/supercompact force` for immediate explicitly authorized supercompaction.
- Change `/supercompact allow` into a live-session policy override and add `/supercompact forbid`; remove the unreleased `enable` and `disable` commands.
- Keep allow/forbid overrides in memory without rewriting global or trusted-project configuration.
- Require enforceable TUI or RPC confirmation for every agent-initiated compaction and fail closed without confirmation UI.
- Add synchronous confirmation locking, post-dialog authorization checks, cancellation handling, and concurrent-request safeguards.
- Preserve user-confirmed continuation intent, exact next actions, and conservative downgrades across compaction.
- Add preparation-message filtering and cache-conscious public-tool reconciliation through workflow settlement.
- Preserve established non-obvious constraints and source-of-truth decisions across continuation.

## 0.1.0 - 2026-07-19

- Add `/supercompact [extra context]`.
- Queue full-context summarization as steering work.
- Run native Pi compaction and restore a continuation-aware context summary.
- Record continuation with a temporary schema-validated tool while keeping the summary as ordinary Markdown.
- Retain only the newest hidden super-summary and filter completed internal metadata artifacts from model context.
- Add bounded decision retries, targeted file-reread guidance, working messages, and decision-specific notifications.
