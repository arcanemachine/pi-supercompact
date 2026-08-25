# Changelog

## Unreleased

## 0.3.4 - 2026-08-24

- Condense supercompact tool descriptions and parameters while preserving authorization and preparation guidance.

## 0.3.3

- Use smaller logo.

## 0.3.2

- Document the parent Pi extensions project.

- Show explicit continuation overrides alongside run and force progress notifications.
- Add descriptive command and continuation-flag autocomplete help for `/supercompact` actions.
- Add authoritative `--stop` and `--continue` flags to explicit `/supercompact run` and `/supercompact force` commands; the selected continuation cannot be changed by the agent and is cleared with the workflow.
- Treat Escape-aborted preparation, decision, and canonical-summary turns as terminal cancellation instead of automatically starting the same correction turn; provider errors and truncation remain bounded and recoverable.
- Avoid duplicating active decision and summary progress notifications alongside Pi's working indicator; queued work and explicit extra context remain visible.
- Ignore unexpected internal decision calls silently outside the dedicated decision phase, preventing normal prompts from entering corrective retry loops.
- Avoid redundant continuation turns for prepared requests by carrying their validated outcome directly into the Markdown summary; unprepared decision turns now tolerate incidental prose around one valid decision call and render concrete validation errors.
- Split continuation control from canonical handoff generation: record the short validated decision in its own tool-only turn, then generate the long Markdown summary without a follow-up tool call; native compaction starts automatically after valid summary prose.
- Add opt-in automatic supercompact with configurable 80% preparation and 90% force thresholds, process flags, and live-session controls under `/supercompact`.
- Add `/supercompact auto-enable` and `/supercompact auto-disable` for automatic thresholds, plus `agent-driven-*` permission controls for agent-driven requests.
- Run automatic workflows without a confirmation dialog, preserve momentum for clearly unfinished authorized work, attempt each threshold once per crossing, retain the existing pre-native abort control, and document Pi native compaction's overflow-recovery fallback.
- Treat an explicit `/supercompact run` as its own no-confirm authorization, like `force`: the command itself is the approval, so no final confirmation dialog opens — including headless sessions and while a live-session agent-driven permission mode is active. The final dialog now guards only agent-driven requests; `requireConfirmation` remains accepted as the fallback for `agentRequestsRequireConfirmation` and no longer affects prepared runs.

## 0.3.1 - 2026-07-27

- Fix logo

## 0.3.0 - 2026-07-27

- Add `/supercompact agent-driven-allow-noconfirm-once` as a non-persistent overlay for one successfully queued agent-driven request, with automatic restoration, redundant-permission warnings, lifecycle and superseding-command cancellation, headless support, and unchanged workflow guards.
- Keep canonical-summary requests active across failed, aborted, truncated, unusable, or metadata-invalid assistant turns so normal retries and resends can complete the existing workflow.
- Distinguish the transient summary spinner as `Summarizing…` from the one-time creation notification.

## 0.2.0 - 2026-07-22

- Provide `/supercompact run`, `/supercompact force`, `/supercompact agent-driven-allow`, `/supercompact agent-driven-allow-noconfirm`, `/supercompact agent-driven-deny`, and `/supercompact abort` for preparation, explicit immediate execution, request permission, and pre-native cancellation.
- Keep the public request and internal decision tool schemas active throughout the extension session while enforcing authorization and workflow phases at execution time.
- Use `requireConfirmation` as the global confirmation default, `agentRequestsAllowed` for persistent request permission, and inheritable `agentRequestsRequireConfirmation` for config-authorized requests, with trusted-project policy precedence and invalid configuration failing closed.
- Respect explicit Pi tool exclusions and report actionable diagnostics without changing the host's active tool selection.
- Give state-specific guidance for denied, busy, confirming, headless, declined, canceled, revoked, unavailable-tool, and failed requests.
- Support configured and explicit session no-confirm permission that skips only the final dialog, works headlessly, reapplies configured behavior on lifecycle initialization, and retains every preparation, validation, summary, retry, compaction, restoration, and cleanup guard.
- Keep normal `agent-driven-allow` confirmation-required, retain immediate dialog-free `force`, and make `agent-driven-deny` revoke either live-session permission mode.
- Cancel pending preparation, confirmation, and canonical-summary work through `abort`, preserve permission and schemas, report idle use as an error, and delegate active native-compaction cancellation to Escape or the host.
- Render user preparation context completely in confirmation while limiting agent-created values to blank-line-separated 10-word previews; preserve every complete value in the canonical summary and restored continuation metadata.
- Keep preparation and summary prompts self-contained across coding, documentation, research, planning, and mixed sessions, with conditional verification and persistence guidance.
- Preserve confirmed continuation intent, exact next actions, conservative stop downgrades, bounded retries, context filtering, and native-compaction restoration.
- Show each continue-or-wait outcome once in TUI scrollback through a durable custom entry that does not enter model context or trigger another turn.
- Keep configured permission silent in the status area and restore explicit live-session overrides across `/reload`.
- Give every visible footer status a clamp suffix and trailing separator spacing.
- Avoid extension-driven active-tool schema changes so extension workflow transitions do not invalidate an otherwise reusable prompt-cache prefix.

## 0.1.0 - 2026-07-19

- Add deliberate full-context summarization before native Pi compaction.
- Restore a continuation-aware canonical context after compaction.
- Record continuation through schema-validated internal workflow control while retaining the summary as ordinary Markdown.
- Filter duplicate restored summaries and completed internal control artifacts from later provider context.
- Add bounded decision retries, targeted resource guidance, working messages, and decision-specific notifications.
