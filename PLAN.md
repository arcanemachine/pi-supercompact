# Stable-schema supercompact authorization plan

## Objective

Keep both extension tool schemas active for the entire Pi session so `/supercompact run`, `/supercompact allow`, `/supercompact allow-noconfirm`, `/supercompact deny`, `/supercompact abort`, summary preparation, and workflow cleanup do not change the provider tool list or invalidate an otherwise reusable prompt-cache prefix.

Support configurable confirmation through a global default plus an agent-request-specific override. Keep explicit live-session `allow` confirmation-required, keep `allow-noconfirm` dialog-free, keep `/force` immediate, and preserve every other runtime and workflow guard.

Add `/supercompact abort` to cancel extension-controlled preparation, confirmation, and canonical-summary work before Pi native compaction begins, with an idle error notification and an explicit Escape fallback once native compaction owns cancellation.

Tool visibility must not grant authority. The public `supercompact` tool and internal `record_supercompact_decision` tool must remain protected by authoritative runtime state checks and return the most useful agent-facing message for the exact state in which an invalid call occurs.

## Plan lifecycle

This file is the implementation source of truth across the upcoming compaction boundary.

1. Commit this plan in the child package before compaction, then commit the updated child pointer in the superproject.
2. After compaction, re-read this file completely before editing implementation files.
3. Keep this file until implementation, documentation, automated validation, live Pi verification, and the final plan-to-code audit are complete.
4. If implementation reveals a material conflict, update this plan or ask the user rather than silently changing direction.
5. Delete this file only after every completion criterion below passes.
6. Include deletion in the completed child-package feature commit, then commit only the updated `packages/pi-supercompact` pointer in the superproject.

Do not modify unrelated `packages/pi-workflow` work. Do not push or publish.

## Accepted behavior

### Stable schemas

Register these tools exactly once when the extension loads and leave both active throughout the extension session:

- `supercompact`
- `record_supercompact_decision`

The extension must not add or remove either tool in response to configuration, `/run`, `/allow`, `/allow-noconfirm`, `/deny`, `/abort`, confirmation, summary phases, success, failure, session replacement, or shutdown.

Remove the extension's dynamic active-tool machinery:

- `setToolActive`
- `reconcileAgentTool`
- lazy decision-tool registration
- decision-tool activation and deactivation
- public-tool removal during denial, failure, settlement, or lifecycle cleanup

Implement one canonical stable-schema path without aliases or alternate activation modes.

The extension must not call `pi.setActiveTools()` for its own authorization state. This preserves user or host tool-selection policy and prevents the extension from creating schema churn. `pi.getActiveTools()` may be used only to diagnose whether an explicitly excluded tool makes a command workflow unavailable.

If Pi or the user explicitly excludes either tool through host-level tool selection, the extension must respect that choice rather than re-adding the tool.

### Runtime authorization

The public tool remains visible but must execute only when one of these is true:

- effective session permission is confirmation-required `allowed` or session-only `allowed-noconfirm`; or
- an unused `/supercompact run` preparation grant exists.

The runtime state remains authoritative:

```ts
type AgentPermission = "allowed" | "allowed-noconfirm" | "denied";

type ConfiguredPermission = AgentPermission;
type SessionPermissionOverride = AgentPermission;

let configuredPermission: ConfiguredPermission = "denied";
let sessionPermissionOverride: SessionPermissionOverride | undefined;
let preparationGrant: PreparationGrant | undefined;
let confirmationId: string | undefined;
let request: SupercompactRequest | undefined;
```

Derived permission:

```ts
const effectivePermission = sessionPermissionOverride ?? configuredPermission;
```

The public tool's presence in the tool list must never be treated as authorization. The execute handler must recheck request, confirmation, permission, grant consumption, grant revocation, UI requirements, internal-tool availability, and authorization at the last applicable boundary.

### Configuration

Configuration describes request permission, the global confirmation default, and an optional agent-request-specific override:

```json
{
  "requireConfirmation": true,
  "agentRequestsAllowed": true,
  "agentRequestsRequireConfirmation": false
}
```

Locations remain:

- Global: `~/.pi/agent/pi-supercompact.json`
- Trusted project: `<project>/.pi/pi-supercompact.json`

Rules:

1. Missing configuration defaults to denied.
2. A trusted project value overrides the global value.
3. Invalid configuration fails closed and warns when UI is available.
4. Only the boolean `agentRequestsAllowed` property grants configured request permission; unrecognized properties do not grant access.
5. `requireConfirmation` is optional, must be boolean when present, and defaults to `true`. It controls prepared `/run` requests when no explicit allowed session override selects a confirmation mode.
6. `agentRequestsRequireConfirmation` is optional, must be boolean when present, and inherits `requireConfirmation` when omitted. It controls config-authorized agent requests.
7. `agentRequestsRequireConfirmation: false` yields configured `allowed-noconfirm` only when `agentRequestsAllowed` is also `true`; it never grants request permission by itself.
8. Any recognized confirmation property with a non-boolean value makes the configuration invalid and fails closed to denied requests with confirmation required.
9. `/allow`, `/allow-noconfirm`, and `/deny` remain live-session, in-memory overrides and never write configuration.
10. Lifecycle initialization discards the override and reapplies configured denied, confirmation-required allowed, or no-confirm allowed permission.
11. Each `/run` grant captures the applicable global confirmation requirement when created so later configuration or lifecycle changes cannot reinterpret that one-off authorization.

With no live-session override, the confirmation matrix is:

| `requireConfirmation` | `agentRequestsRequireConfirmation` | Prepared `/run` | Config-authorized agent request |
| --------------------- | ---------------------------------- | --------------- | ------------------------------- |
| `true`                | omitted                            | confirm         | confirm                         |
| `false`               | omitted                            | no confirm      | no confirm                      |
| `false`               | `true`                             | no confirm      | confirm                         |
| `true`                | `false`                            | confirm         | no confirm                      |

Explicit live-session modes take precedence for authorized agent-tool execution: `allow` requires confirmation and `allow-noconfirm` skips it. `deny` blocks unprepared requests but does not invalidate a later explicit one-off `/run` grant. `/force` always skips preparation and confirmation because the command itself is immediate user authorization.

### No-confirm permission and session overrides

Add this positional command keyword to the existing command and menu model:

```text
/supercompact allow-noconfirm
```

Do not implement slash-command `--flag` parsing. Pi passes extension command arguments as raw text and its extension examples favor positional keywords or distinct commands. `allow-noconfirm` must appear in argument completions and as a clearly labeled menu action.

Semantics:

1. `allow-noconfirm` grants agent request permission and waives the final confirmation dialog through an in-memory override for the current live extension session.
2. The command never writes configuration. Persistent no-confirm behavior for config-authorized agent requests requires `agentRequestsAllowed: true` plus either `agentRequestsRequireConfirmation: false` or an inherited `requireConfirmation: false`.
3. Normal `allow` continues to grant agent request permission with final confirmation required, overriding configured no-confirm permission for the current live session. `allow-noconfirm` overrides configured confirmation-required permission.
4. `deny` revokes either allowed mode, cancels unused preparation or an open confirmation, and returns the session to explicit denial.
5. Session start, reload, resume, fork, and shutdown discard the override and reapply configured permission, including configured `allowed-noconfirm` when both required booleans select it.
6. No-confirm mode skips only `ctx.ui.confirm`. It does not bypass focused preparation expectations, exact-next-action validation, busy/concurrency checks, internal-tool availability, summary validation, hard-stop constraints, bounded retries, native compaction, filtering, restoration, or cleanup.
7. Because no dialog is required, an authorized no-confirm request may execute without TUI or RPC UI capability. Prepared `/run` uses `requireConfirmation` when no explicit allowed session override selects a mode; `allow` requires the dialog and `allow-noconfirm` waives it.
8. The public tool should return an explicit success result stating that session no-confirm permission authorized and queued the workflow.
9. Status should distinguish the mode with `supercompact: allowed without confirmation`.
10. Notifications and documentation must state plainly that the mode permits agent-requested compaction without another approval prompt.

### Abort command

Add this positional command and menu action:

```text
/supercompact abort
```

Rules:

1. `abort` accepts no extra arguments and appears in usage text, argument completions, and the menu.
2. It cancels extension-controlled pending preparation, an open confirmation, or queued/active canonical-summary work before Pi native compaction begins.
3. Cancellation revokes and clears the applicable preparation grant, confirmation controller, request, decision-call state, working message, and status without changing permission or either tool schema.
4. When an agent turn is processing preparation or the canonical summary, call `ctx.abort()` after marking extension state canceled so later settlement handlers cannot restart or misreport the workflow. Stale hidden controls remain filtered.
5. If no extension-controlled workflow is active, emit a regular Pi error notification: `No supercompaction is active.`
6. Pi's extension context does not expose `abortCompaction()`. Once native compaction begins, the command must not claim it can cancel that operation; notify the user to press Escape in TUI. RPC or headless callers must use the host's native cancellation mechanism when one is available.
7. Aborting never changes configured or session request permission and never starts or retries another workflow.

### Public-tool description

Rewrite the permanent public-tool description for always-visible semantics. It must state:

- availability does not imply authorization;
- the tool requests supercompaction but never grants its own authority;
- final user confirmation is normally required, while explicit live-session no-confirm permission may waive only that dialog;
- the agent must complete the focused preparation checks first;
- the agent should call after an explicit hidden `/run` preparation request, or when the conversation makes supercompaction appropriate and session permission may exist;
- the execute result will explain whether authorization is absent, confirmation is required, or no-confirm permission queued the workflow;
- the agent must not repeatedly retry a denied, declined, revoked, busy, unavailable, or confirmation-required headless request.

Do not add a dynamic prompt snippet or prompt guideline. Dynamic prompt text would undermine the stable-prefix objective.

### Internal decision-tool description

Register `record_supercompact_decision` eagerly beside the public tool.

Its permanent description must state that it is internal workflow control and must be called only when the hidden canonical-summary prompt explicitly requires it. Availability alone is never an instruction to call it.

Its execute handler remains authoritative and rejects every call unless:

- a request exists;
- the request is in `awaiting-summary`;
- the current response contains the required non-empty Markdown summary;
- the response contains exactly one allowed decision call and no other tool calls;
- any confirmed hard-stop constraint is respected.

Keeping this tool active must not weaken transcript filtering, render suppression, bounded correction, recursion prevention, or hard-stop enforcement.

## Informative agent-facing outcomes

Centralize or consistently construct state-specific messages. Do not collapse materially different states into a generic `not authorized` or `already in progress` error.

### Public `supercompact` tool

Use these semantic outcomes; exact prose may be polished, but every message must contain the listed action guidance.

| Circumstance                                                        | Required agent-facing guidance                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default or configured permission is denied and no grant exists      | The request is not authorized. The user must run `/supercompact run` for a prepared one-off request, `/supercompact allow` for confirmation-required live-session permission, or `/supercompact allow-noconfirm` for live-session permission without the final dialog. Do not retry automatically; wait for the user. |
| Session override is explicitly denied                               | The user explicitly denied agent supercompaction requests for this live session. Only the user can reauthorize with `/supercompact run`, `/supercompact allow`, or `/supercompact allow-noconfirm`. Do not retry automatically.                                                                                       |
| A summary or native compaction request is active                    | Supercompaction is already in progress. Do not submit another request; wait for the existing workflow to settle.                                                                                                                                                                                                      |
| A confirmation dialog is active                                     | A confirmation is already awaiting the user's response. Do not open or retry another request; wait for the result.                                                                                                                                                                                                    |
| Confirmation-required permission exists but `ctx.hasUI` is false    | Agent-triggered supercompaction requires TUI or RPC confirmation in the current permission mode. The user must invoke `/supercompact force` explicitly or enable `/supercompact allow-noconfirm`. Do not retry automatically.                                                                                         |
| `nextAction` is empty                                               | Supply one concrete next action, or explicitly state that the agent will wait for the user.                                                                                                                                                                                                                           |
| Confirmation is declined                                            | The user declined this request. Do not retry automatically; wait for user direction.                                                                                                                                                                                                                                  |
| Confirmation is canceled                                            | The confirmation was canceled. Do not retry automatically; wait for user direction.                                                                                                                                                                                                                                   |
| Authorization is revoked or expires while the dialog is open        | The request is no longer authorized. Do not retry automatically; wait for the user to reauthorize.                                                                                                                                                                                                                    |
| Summary workflow cannot start because the internal tool is excluded | Explain that the required internal decision tool is unavailable in the current Pi tool selection and that the user must re-enable it or reload with the extension tools available.                                                                                                                                    |
| Session no-confirm permission authorizes execution                  | State that explicit live-session no-confirm permission authorized the request and that canonical summary and native compaction were queued without a confirmation dialog.                                                                                                                                             |
| Summary queueing or native compaction fails                         | Preserve the current specific failure reason and state that no automatic retry will occur.                                                                                                                                                                                                                            |

Thrown tool errors are agent-visible results and must be as actionable as returned decline/cancellation results.

### Internal decision tool

| Circumstance                                             | Required agent-facing guidance                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| No request exists                                        | No supercompact summary is awaiting a decision. Call this tool only when the hidden canonical-summary prompt explicitly requests it. |
| Request is queued but summary phase has not begun        | Wait for the canonical-summary request; do not call the decision tool yet.                                                           |
| Wrong workflow phase after decision or during compaction | A decision has already been recorded or the workflow has advanced; do not retry.                                                     |
| Markdown summary is missing                              | Write the requested non-empty Markdown handoff before recording the decision.                                                        |
| Batch contains another tool or duplicate decision calls  | Call the decision tool exactly once and call no other tool in the summary response.                                                  |
| User-confirmed stop conflicts with `continue`            | The user's confirmed stop is a hard constraint; correct the decision to `stop`.                                                      |
| Repeated invalid metadata reaches the retry limit        | Preserve the bounded-failure behavior and tell the agent the workflow stopped without starting another request.                      |

### Command-side diagnostics

Commands cannot rely on a tool becoming active because schemas are stable.

Before `/run` sends preparation:

1. Require TUI or RPC confirmation capability unless effective session permission is `allowed-noconfirm`.
2. Verify the public tool is present in Pi's active tool selection.
3. Verify the internal decision tool is present, because accepted confirmation would otherwise be unable to summarize.
4. If either is excluded, do not create a grant or send preparation. Notify the user which required tool is unavailable and that Pi tool selection or extension loading must be corrected.

Before `/force` begins summary, verify the internal decision tool is available. Fail early with the same actionable diagnostic.

`/allow`, `/allow-noconfirm`, and `/deny` still update permission and status even if host-level tool selection excludes the public tool, but notify the user that permission changed while execution remains unavailable until the tool is re-enabled.

## Status and lifecycle behavior

Status continues to describe permission and workflow state, never schema state:

- pending preparation: `supercompact: preparing`
- confirmation: `supercompact: awaiting confirmation`
- effective confirmation-required permission: `supercompact: allowed`
- effective no-confirm permission: `supercompact: allowed without confirmation`
- denied with no workflow: no status

Replace all schema reconciliation calls with status reconciliation. State cleanup must still:

- clear unused or consumed preparation grants as appropriate;
- abort and clear confirmation controllers;
- clear decision call IDs;
- restore the default working message;
- preserve or reset session permission according to lifecycle rules;
- leave both tool schemas untouched.

`/deny` must revoke confirmation-required or no-confirm runtime permission and cancel unused preparation or confirmation without removing either schema. It must not corrupt an active canonical summary or native compaction.

Session start, shutdown, success, decline, cancellation, revocation, queue failure, summary failure, and compaction failure must all leave authorization and UI state correct while the active tool vector remains unchanged.

## Cache behavior and limits

With both schemas active from extension load:

- `/run` adds only the hidden preparation message and changes in-memory state/status;
- `/allow`, `/allow-noconfirm`, `/deny`, and `/abort` change only in-memory workflow or permission state/status;
- entering, aborting, and leaving the canonical-summary phase does not alter the active tool vector;
- success and failure cleanup do not alter the active tool vector.

This removes extension-caused mid-session schema invalidation. It does not guarantee provider cache hits: expiration, provider policy, model changes, unrelated extension changes, host tool selection, system-prompt changes, and conversation-prefix differences can still miss.

The README must state this distinction and must not promise that every provider request will hit cache.

## Concise confirmation presentation

Keep the final confirmation dialog scannable. The dialog is a compact preview, not the canonical record.

Display these blocks when applicable:

1. Post-compaction behavior
2. Next action
3. Preparation context
4. Additional summary context
5. The statement that confirmation begins the canonical summary and native compaction

Separate every displayed block with one blank line. Omit absent optional blocks without leaving duplicate blank lines.

The behavior label remains complete. Limit each freeform value (`nextAction`, preparation context, and additional summary context) to the first 10 whitespace-delimited words for display:

- trim leading and trailing whitespace;
- collapse internal whitespace and line breaks to single spaces;
- preserve the complete value when it contains 10 words or fewer;
- when it contains more than 10 words, display the first 10 followed immediately by a single Unicode ellipsis (`…`);
- do not add an ellipsis to an untruncated value.

Example:

```text
Post-compaction behavior: continue authorized work

Next action: Begin Task 4: write final user documentation and run focused validation…

Preparation context: then continue with the remaining items

Additional summary context: Tasks 1-3 are complete and verified; continue with final documentation…

Confirming will begin the canonical super-summary and native compaction immediately.
```

Truncation is presentation-only. Preserve the complete next action and both context values in confirmation state, the summary prompt, continuation metadata, and restored canonical context. Add a pure display-preview helper so UI truncation cannot accidentally mutate durable workflow data.

## Evergreen prompt content

Treat every permanent tool description, hidden preparation prompt, canonical-summary prompt, continuation message, error, and notification as standalone product language.

Requirements:

1. Do not name or reference external skills, dispatchers, private conventions, authors, organizations, or a particular user's workflow.
2. Do not require knowledge of how the prompt was designed. State the required behavior directly and self-containedly.
3. Use generic role terms such as “user” and “agent” only when the distinction is operationally necessary; do not embed personal preferences or project-specific narrative.
4. Describe current behavior, not migrations, former names, superseded commands, or how the implementation arrived at its current design.
5. Keep instructions applicable across coding, documentation, research, planning, and mixed sessions. Repository, file, validation, and commit checks must be conditional rather than assumed.
6. Preserve focused refresh-and-close behavior without branded terminology:
   - re-read relevant durable sources instead of trusting memory;
   - compare them with actual current state;
   - correct scoped staleness;
   - finish only authorized work that needs no new input;
   - surface blockers and questions;
   - verify or persist work when applicable;
   - establish an exact continuation or stopping point.
7. Replace the preparation headings `Freshen the active context` and `Wrap the active boundary` with neutral, descriptive headings such as `Refresh relevant context` and `Close the active boundary`.
8. Avoid assuming that every session has a Git repository, files to edit, tests to run, or commits to make. Use “when applicable” language and honor whatever scoped project or session rules exist.
9. Keep extra context subordinate to established authorization and constraints without referring to any private workflow.
10. Keep the canonical handoff concise and evergreen. Generalize file-only guidance into relevant resources by work horizon while still preserving exact file paths when files materially affect continuation.

Generic references to the current user, explicit user authorization, and user confirmation are valid because they define the security boundary. They must remain role-based and universal.

Add focused prompt-contract tests that reject skill names, private-workflow references, migration language, and unconditional repository assumptions while asserting the required refresh, closure, authorization, blocker, verification, and exact-next-action concepts.

## Execution sequence

Use this order so the stable-schema work remains coherent and the new permission mode is verified as part of the final product:

1. Preserve the completed stable-schema, runtime-gating, concise-preview, prompt, documentation, and test changes already present in the working tree.
2. Re-run the focused baseline tests after compaction before changing permission or abort behavior.
3. Preserve the completed live-session `allow-noconfirm` implementation and add `requireConfirmation` plus `agentRequestsRequireConfirmation` parsing and precedence without weakening explicit session overrides or any non-dialog workflow guard.
4. Implement `/supercompact abort` for extension-controlled pre-native phases with the documented native Escape boundary.
5. Add focused tests, then update README and changelog to describe the complete resulting behavior.
6. Run all package and filtered-workspace validation.
7. Repeat focused live Pi verification for configured no-confirm permission and abort behavior; retain the already-passing confirmed and no-confirm RPC compactions as evidence unless implementation changes invalidate them.
8. Perform the final plan-to-code audit, remove this plan only when every criterion passes, commit child before parent, and report the full completed work.

## Implementation outline

### `src/index.ts`

1. Use request permission terminology consistently throughout configuration and runtime state.
2. Parse the boolean `agentRequestsAllowed` property and fail closed for missing or invalid permission.
3. Register the internal decision tool eagerly during extension initialization.
4. Keep public and internal tools active after registration.
5. Remove dynamic tool activation/deactivation and lazy registration state.
6. Add small helpers for host-level tool availability diagnostics without changing active tools.
7. Replace schema reconciliation call sites with status-only updates and state cleanup.
8. Add state-specific public authorization, busy, confirmation, headless, revocation, and failure messages.
9. Add state-specific internal decision-tool phase messages.
10. Add a pure 10-word display-preview helper and render confirmation blocks with blank-line separation.
11. Keep full confirmation values in summary and continuation state; truncate only dialog presentation.
12. Rewrite permanent prompt and tool text according to the evergreen prompt-content requirements.
13. Generalize canonical handoff resource guidance without losing exact actionable references.
14. Preserve preparation, final confirmation whenever the permission mode requires it, summary generation, continuation constraints, filtering, retry bounds, compaction, and restoration behavior.
15. Add `allow-noconfirm` parsing, completion, menu handling, notification, status, and lifecycle reset.
16. Skip the final dialog only when effective session permission is exactly `allowed-noconfirm`, then begin the existing canonical-summary path directly.
17. Permit no-confirm execution without UI while retaining the current headless rejection and `/force` guidance for confirmation-required permission.
18. Keep the full request, preparation, internal-tool, summary, compaction, and restoration gates identical after either confirmed or no-confirm authorization.
19. Parse `requireConfirmation` with a true default and parse `agentRequestsRequireConfirmation` as an optional override inheriting the global value; derive configured `allowed-noconfirm` only when agent requests are also allowed.
    19a. Capture the applicable confirmation requirement in each `/run` grant so later configuration or lifecycle changes cannot ambiguously reinterpret prepared authorization. Keep `/force` immediate and dialog-free.
20. Add abort parsing, completion, menu handling, phase-aware cleanup, error notification, and native-compaction Escape guidance.

### `tests/index.test.ts`

Update the harness and assertions for permanently active schemas. Keep all current behavioral regression coverage.

Add or revise tests for:

1. Both tools are registered exactly once at extension load.
2. Both tools remain in the active vector when config is missing, false, true, invalid, globally set, or project-overridden.
3. The extension never calls `pi.setActiveTools()` during initialization or any workflow transition.
4. Active tools remain identical across `/run`, `/allow`, `/allow-noconfirm`, `/deny`, `/abort`, confirmation acceptance, no-confirm execution, decline, cancellation, revocation, summary validation, success, failure, session start, and shutdown.
5. Missing config rejects a public call with `/run`, `/allow`, and `/allow-noconfirm` guidance.
6. Explicit `/deny` rejects with an explicit-user-revocation message distinct from default denied.
7. Active confirmation rejects duplicates with wait-for-confirmation guidance.
8. Active summary/compaction rejects duplicates with wait-for-settlement guidance.
9. Headless confirmation-required execution directs the user to TUI/RPC, explicit `/force`, or `/allow-noconfirm` and prohibits automatic retry.
10. Empty `nextAction` gives concrete correction guidance.
11. Decline, cancellation, and dialog-time revocation each return distinct actionable guidance.
12. The internal decision tool rejects an out-of-workflow call with hidden-summary-only guidance.
13. Internal queued, already-decided, missing-summary, mixed-batch, duplicate, and hard-stop states remain distinct and actionable.
14. `agentRequestsAllowed` global and trusted-project precedence works.
15. Configuration without a recognized permission property defaults to denied.
16. `/allow`, `/allow-noconfirm`, and `/deny` remain in memory and never write config.
17. `/run` fails before creating a grant when the public or internal tool is excluded by host selection.
18. `/force` fails before summary when the internal tool is excluded.
19. `/allow`, `/allow-noconfirm`, and `/deny` report permission plus host-level unavailability when the public tool is excluded.
20. Preparation and summary prompts contain no skill names, private-workflow references, personal names, migration language, or unconditional repository assumptions.
21. Prompt tests preserve focused context refresh, scoped staleness correction, authorized completion, blockers, conditional verification/persistence, continuation choice, and exact-next-action guidance.
22. Confirmation previews preserve values of 10 words or fewer and truncate longer values to exactly 10 words plus one Unicode ellipsis.
23. Confirmation preview tests cover whitespace normalization, multiline input, absent optional contexts, and one blank line between every displayed block.
24. Full next-action and context values remain unchanged in the canonical summary prompt and restored workflow metadata after their dialog previews are truncated.
25. Existing preparation, confirmation, continuation, filtering, auto-compaction, bounded retry, synchronous failure, and restoration tests continue to pass.
26. `allow-noconfirm` is present in completions and the menu and rejects extra arguments.
27. `allow-noconfirm` sets distinct session status, never writes config, and resets to configured confirmation-required permission on lifecycle initialization.
28. An authorized no-confirm public call opens no dialog, returns explicit no-confirm authorization guidance, and starts exactly one summary workflow.
29. No-confirm mode works without UI but still rejects empty next actions, busy workflows, and missing internal-tool availability.
30. Normal `allow` continues to require confirmation, and `deny` revokes both allowed modes.
31. Prepared `/run` execution skips its dialog only while no-confirm session permission is active.
32. Active tools remain identical throughout no-confirm command, execution, summary, success, failure, denial, and lifecycle cleanup.
33. Missing `requireConfirmation` defaults true; missing `agentRequestsRequireConfirmation` inherits it; every global/specific true/false combination produces the documented `/run` versus config-authorized-agent matrix; false without allowed grants nothing; invalid values fail closed; project precedence applies to all properties as one configuration.
34. Lifecycle reset restores configured no-confirm permission, while session `allow`, `allow-noconfirm`, and `deny` override it only in memory.
35. `abort` rejects extra arguments, appears in completions and the menu, preserves permission and schemas, and emits `No supercompaction is active.` as an error when idle.
36. `abort` cancels pending preparation, open confirmation, queued summary, and active canonical-summary turns without later settlement restarting work.
37. Native-compaction abort attempts give accurate Escape guidance rather than claiming extension cancellation.

### `README.md`

Update:

- all three configuration booleans, defaults, inheritance, precedence, and permission semantics;
- the confirmation matrix for `/run`, config-authorized agent requests, explicit session overrides, and `/force`;
- `allow`, session-only `allow-noconfirm`, configured no-confirm, and `deny` behavior;
- `abort` behavior and the native-compaction Escape boundary;
- the explicit safety distinction between confirmation-required and no-confirm permission;
- always-visible tool behavior;
- authorization as an execute-time gate;
- user and agent messages for denied/headless/busy states;
- stable public and internal schemas;
- cache expectations and remaining provider-dependent miss causes;
- host-level explicit tool exclusion behavior;
- concise 10-word confirmation previews with blank-line-separated blocks;
- the distinction between compact UI previews and lossless canonical context;
- self-contained, universal refresh-and-close behavior without references to external skills or private workflows.

Final documentation must describe only the resulting product behavior. It must not retain superseded terminology, migration narration, or references to the design process.

### `CHANGELOG.md`

Add unreleased entries for:

- stable always-active public and internal schemas;
- execute-time authorization gates;
- `agentRequestsAllowed` configuration;
- state-specific agent guidance;
- elimination of extension-driven tool-schema changes;
- session-only and configured no-confirm permission with preservation of all non-dialog workflow guards;
- pre-native `/supercompact abort` cancellation and the native Escape boundary.

## Validation

Run package validation:

```bash
npm run typecheck
npm run test
npm run build
npm run format
npm pack --dry-run
```

Run filtered workspace validation from `/workspace/projects/pi`:

```bash
corepack pnpm --filter @arcanemachine/pi-supercompact run typecheck
corepack pnpm --filter @arcanemachine/pi-supercompact run test
corepack pnpm --filter @arcanemachine/pi-supercompact run build
```

Run `git diff --check` and confirm no unrelated child or superproject changes are staged.

## Live Pi verification

Use an isolated Pi process with only this extension explicitly loaded. Verify:

1. Both tools are present immediately after startup with default-denied configuration.
2. An unauthorized public tool attempt receives the exact user-authorization guidance and starts no dialog or summary.
3. `/run` starts preparation without changing the active tool vector.
4. `/allow`, `/allow-noconfirm`, and `/deny` change permission/status without changing the active tool vector.
5. Normal `allow` execution still opens final confirmation.
6. Long next-action and context values render as 10-word previews with ellipses and blank lines between blocks.
7. The canonical summary still receives every untruncated value shown as a shortened preview.
8. Decline, cancellation, and revocation give distinct no-retry guidance.
9. Accepted confirmation completes summary and native compaction.
10. `allow-noconfirm` execution opens no confirmation dialog, reports the bypass explicitly, and completes summary and native compaction.
11. No-confirm execution works without UI and configured no-confirm permission is restored after lifecycle reset.
    11a. `/abort` cancels each extension-controlled pre-native phase, preserves permission and schemas, reports an idle error notification, and gives Escape guidance at the native-compaction boundary.
12. `/deny` revokes no-confirm permission and `/force` works while public requests are denied.
13. The internal tool rejects an out-of-workflow call and works during both confirmed and no-confirm canonical summary turns.
14. The active tool vector is unchanged before preparation, during confirmed and no-confirm summaries, and after settlement.
15. On a session with a reusable long prefix, `/run`, no-confirm execution, and summary-phase entry produce no extension-caused schema change. Record cache observations as provider-dependent evidence, not a guaranteed assertion.
16. Confirm no verification process modified project files.
17. Check for attached tmux clients before cleaning up every verification session.

## Completion and deletion criteria

Delete this plan only after all of the following are true:

1. Both tool schemas are registered eagerly and remain stable.
2. The extension makes no authorization-driven `setActiveTools()` calls.
3. Runtime gates prevent unauthorized public and internal execution.
4. State-specific agent guidance is implemented and tested.
5. Configuration uses `requireConfirmation`, `agentRequestsAllowed`, and `agentRequestsRequireConfirmation`; missing, unrecognized, and invalid request permission fails closed, global confirmation defaults to required, the agent-specific value inherits the global default, and no confirmation property grants request permission.
6. No-confirm permission skips only the final dialog, works headlessly, can come from configuration or a session override, restores correctly on lifecycle initialization, and is revoked by session `deny`.
   6a. `/supercompact abort` cancels extension-controlled pre-native phases, preserves permission and schemas, reports idle use as an error, and accurately delegates native compaction cancellation to Escape.
7. Preparation, confirmation, no-confirm authorization, continuation, filtering, retry, cleanup, and compaction regressions pass.
8. Confirmation displays only 10-word freeform previews with blank-line-separated blocks while canonical workflow data remains lossless.
9. Every permanent prompt and tool description is self-contained, evergreen, broadly applicable, and free of skill or private-workflow references.
10. README and changelog describe only the final behavior without stale dynamic-schema or migration language.
11. Package and workspace validation pass.
12. Live Pi verification passes, including stable active tools, a confirmed compaction workflow, and a no-confirm compaction workflow.
13. A final review finds no unresolved item, unsupported assumption, or unrelated modification.

Then delete `PLAN.md`, commit the child package with a Conventional Commit, and commit only the updated `packages/pi-supercompact` pointer in the superproject. Do not push or publish.

## Post-compaction continuation directive

After the upcoming compaction, continue this authorized task automatically without requesting approval already given.

Immediate next action:

1. Re-read this entire plan.
2. Revalidate the child and superproject working trees, preserving unrelated `packages/pi-workflow` work.
3. Re-read the current `src/index.ts` and `tests/index.test.ts` before editing.
4. Re-run focused baseline tests for the stable-schema implementation already in the working tree.
5. Preserve the completed live-session `allow-noconfirm` work, implement the `requireConfirmation` and `agentRequestsRequireConfirmation` precedence matrix, and add `/supercompact abort` according to the semantics and execution sequence above.
6. Update README and changelog for both additions, including the native-compaction Escape boundary.
7. Finish all remaining validation, focused live verification, audit, plan deletion, and child-before-parent commits without requesting approval already given.
8. Deliver a concise final report summarizing the complete stable-schema, authorization, confirmation-preview, prompt, documentation, validation, live-verification, no-confirm, abort, and commit work. The exact final word of that report must be `Pickle.`
