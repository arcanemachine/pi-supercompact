# Changelog

## Unreleased

- Provide `/supercompact run`, `/supercompact force`, `/supercompact allow`, `/supercompact allow-noconfirm`, `/supercompact deny`, and `/supercompact abort` for preparation, explicit immediate execution, request permission, and pre-native cancellation.
- Keep the public request and internal decision tool schemas active throughout the extension session while enforcing authorization and workflow phases at execution time.
- Use `requireConfirmation` as the global confirmation default, `agentRequestsAllowed` for persistent request permission, and inheritable `agentRequestsRequireConfirmation` for config-authorized requests, with trusted-project policy precedence and invalid configuration failing closed.
- Respect explicit Pi tool exclusions and report actionable diagnostics without changing the host's active tool selection.
- Give state-specific guidance for denied, busy, confirming, headless, declined, canceled, revoked, unavailable-tool, and failed requests.
- Support configured and explicit session no-confirm permission that skips only the final dialog, works headlessly, reapplies configured behavior on lifecycle initialization, and retains every preparation, validation, summary, retry, compaction, restoration, and cleanup guard.
- Keep normal `allow` confirmation-required, retain immediate dialog-free `force`, and make `deny` revoke either live-session permission mode.
- Cancel pending preparation, confirmation, and canonical-summary work through `abort`, preserve permission and schemas, report idle use as an error, and delegate active native-compaction cancellation to Escape or the host.
- Render confirmation context as blank-line-separated 10-word previews while preserving complete values in the canonical summary and restored continuation metadata.
- Keep preparation and summary prompts self-contained across coding, documentation, research, planning, and mixed sessions, with conditional verification and persistence guidance.
- Preserve confirmed continuation intent, exact next actions, conservative stop downgrades, bounded retries, context filtering, and native-compaction restoration.
- Show each continue-or-wait outcome once in TUI scrollback through a durable custom entry that does not enter model context or trigger another turn.
- Keep configured permission silent in the status area and show concise, separator-terminated permission status only for explicit live-session overrides.
- Avoid extension-driven active-tool schema changes so extension workflow transitions do not invalidate an otherwise reusable prompt-cache prefix.

## 0.1.0 - 2026-07-19

- Add deliberate full-context summarization before native Pi compaction.
- Restore a continuation-aware canonical context after compaction.
- Record continuation through schema-validated internal workflow control while retaining the summary as ordinary Markdown.
- Filter duplicate restored summaries and completed internal control artifacts from later provider context.
- Add bounded decision retries, targeted resource guidance, working messages, and decision-specific notifications.
