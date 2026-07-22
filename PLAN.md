# Stable-schema supercompact authorization plan

## Objective

Keep both extension tool schemas active for the entire Pi session so `/supercompact run`, `/supercompact allow`, `/supercompact forbid`, summary preparation, and workflow cleanup do not change the provider tool list or invalidate an otherwise reusable prompt-cache prefix.

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

The extension must not add or remove either tool in response to configuration, `/run`, `/allow`, `/forbid`, confirmation, summary phases, success, failure, session replacement, or shutdown.

Remove the extension's dynamic active-tool machinery:

- `setToolActive`
- `reconcileAgentTool`
- lazy decision-tool registration
- decision-tool activation and deactivation
- public-tool removal during forbid, failure, settlement, or lifecycle cleanup

Implement one canonical stable-schema path without aliases or alternate activation modes.

The extension must not call `pi.setActiveTools()` for its own authorization state. This preserves user or host tool-selection policy and prevents the extension from creating schema churn. `pi.getActiveTools()` may be used only to diagnose whether an explicitly excluded tool makes a command workflow unavailable.

If Pi or the user explicitly excludes either tool through host-level tool selection, the extension must respect that choice rather than re-adding the tool.

### Runtime authorization

The public tool remains visible but must execute only when one of these is true:

- effective session permission is allowed; or
- an unused `/supercompact run` preparation grant exists.

The existing runtime state remains authoritative:

```ts
type AgentPermission = "allowed" | "forbidden";

let configuredPermission: AgentPermission = "forbidden";
let sessionPermissionOverride: AgentPermission | undefined;
let preparationGrant: PreparationGrant | undefined;
let confirmationId: string | undefined;
let request: SupercompactRequest | undefined;
```

Derived permission:

```ts
const effectivePermission = sessionPermissionOverride ?? configuredPermission;
```

The public tool's presence in the tool list must never be treated as authorization. The execute handler must recheck request, confirmation, permission, grant consumption, grant revocation, UI capability, and post-dialog authorization.

### Configuration

Configuration describes request permission:

```json
{
  "agentRequestsAllowed": true
}
```

Locations remain:

- Global: `~/.pi/agent/pi-supercompact.json`
- Trusted project: `<project>/.pi/pi-supercompact.json`

Rules:

1. Missing configuration defaults to forbidden.
2. A trusted project value overrides the global value.
3. Invalid configuration fails closed and warns when UI is available.
4. Only the boolean `agentRequestsAllowed` property grants configured permission; unrecognized properties do not grant access.
5. `/allow` and `/forbid` remain live-session, in-memory overrides and never write configuration.
6. Lifecycle initialization discards the override and reapplies configuration.

### Public-tool description

Rewrite the permanent public-tool description for always-visible semantics. It must state:

- availability does not imply authorization;
- the tool is a request for final user confirmation, not permission to compact unilaterally;
- the agent must complete the focused preparation checks first;
- the agent should call after an explicit hidden `/run` preparation request, or when the conversation makes supercompaction appropriate and session permission may exist;
- the execute result will explain when the user must authorize the request;
- the agent must not repeatedly retry a denied, declined, revoked, busy, or headless request.

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

| Circumstance                                                        | Required agent-facing guidance                                                                                                                                                                           |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default or configured permission is forbidden and no grant exists   | The request is not authorized. The user must run `/supercompact run` for a prepared one-off request or `/supercompact allow` for live-session permission. Do not retry automatically; wait for the user. |
| Session override is explicitly forbidden                            | The user explicitly forbade agent supercompaction requests for this live session. Only the user can reauthorize with `/supercompact run` or `/supercompact allow`. Do not retry automatically.           |
| A summary or native compaction request is active                    | Supercompaction is already in progress. Do not submit another request; wait for the existing workflow to settle.                                                                                         |
| A confirmation dialog is active                                     | A confirmation is already awaiting the user's response. Do not open or retry another request; wait for the result.                                                                                       |
| Permission exists but `ctx.hasUI` is false                          | Agent-triggered supercompaction requires TUI or RPC confirmation. The user must invoke `/supercompact force` explicitly if immediate headless compaction is desired. Do not retry automatically.         |
| `nextAction` is empty                                               | Supply one concrete next action, or explicitly state that the agent will wait for the user.                                                                                                              |
| Confirmation is declined                                            | The user declined this request. Do not retry automatically; wait for user direction.                                                                                                                     |
| Confirmation is canceled                                            | The confirmation was canceled. Do not retry automatically; wait for user direction.                                                                                                                      |
| Authorization is revoked or expires while the dialog is open        | The request is no longer authorized. Do not retry automatically; wait for the user to reauthorize.                                                                                                       |
| Summary workflow cannot start because the internal tool is excluded | Explain that the required internal decision tool is unavailable in the current Pi tool selection and that the user must re-enable it or reload with the extension tools available.                       |
| Summary queueing or native compaction fails                         | Preserve the current specific failure reason and state that no automatic retry will occur.                                                                                                               |

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

1. Require TUI or RPC confirmation capability as today.
2. Verify the public tool is present in Pi's active tool selection.
3. Verify the internal decision tool is present, because accepted confirmation would otherwise be unable to summarize.
4. If either is excluded, do not create a grant or send preparation. Notify the user which required tool is unavailable and that Pi tool selection or extension loading must be corrected.

Before `/force` begins summary, verify the internal decision tool is available. Fail early with the same actionable diagnostic.

`/allow` and `/forbid` still update permission and status even if host-level tool selection excludes the public tool, but notify the user that permission changed while execution remains unavailable until the tool is re-enabled.

## Status and lifecycle behavior

Status continues to describe permission and workflow state, never schema state:

- pending preparation: `supercompact: preparing`
- confirmation: `supercompact: awaiting confirmation`
- session permission: `supercompact: allowed`
- forbidden with no workflow: no status

Replace all schema reconciliation calls with status reconciliation. State cleanup must still:

- clear unused or consumed preparation grants as appropriate;
- abort and clear confirmation controllers;
- clear decision call IDs;
- restore the default working message;
- preserve or reset session permission according to lifecycle rules;
- leave both tool schemas untouched.

`/forbid` must revoke runtime permission and cancel unused preparation or confirmation without removing either schema. It must not corrupt an active canonical summary or native compaction.

Session start, shutdown, success, decline, cancellation, revocation, queue failure, summary failure, and compaction failure must all leave authorization and UI state correct while the active tool vector remains unchanged.

## Cache behavior and limits

With both schemas active from extension load:

- `/run` adds only the hidden preparation message and changes in-memory state/status;
- `/allow` and `/forbid` change only in-memory state/status;
- entering and leaving the canonical-summary phase does not alter the active tool vector;
- success and failure cleanup do not alter the active tool vector.

This removes extension-caused mid-session schema invalidation. It does not guarantee provider cache hits: expiration, provider policy, model changes, unrelated extension changes, host tool selection, system-prompt changes, and conversation-prefix differences can still miss.

The README must state this distinction and must not promise that every provider request will hit cache.

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
10. Preserve preparation, final confirmation, summary generation, continuation constraints, filtering, retry bounds, compaction, and restoration behavior.

### `tests/index.test.ts`

Update the harness and assertions for permanently active schemas. Keep all current behavioral regression coverage.

Add or revise tests for:

1. Both tools are registered exactly once at extension load.
2. Both tools remain in the active vector when config is missing, false, true, invalid, globally set, or project-overridden.
3. The extension never calls `pi.setActiveTools()` during initialization or any workflow transition.
4. Active tools remain identical across `/run`, `/allow`, `/forbid`, confirmation acceptance, decline, cancellation, revocation, summary validation, success, failure, session start, and shutdown.
5. Missing config rejects a public call with `/run` and `/allow` guidance.
6. Explicit `/forbid` rejects with an explicit-user-revocation message distinct from default forbidden.
7. Active confirmation rejects duplicates with wait-for-confirmation guidance.
8. Active summary/compaction rejects duplicates with wait-for-settlement guidance.
9. Headless agent execution directs the user to TUI/RPC or explicit `/force` and forbids automatic retry.
10. Empty `nextAction` gives concrete correction guidance.
11. Decline, cancellation, and dialog-time revocation each return distinct actionable guidance.
12. The internal decision tool rejects an out-of-workflow call with hidden-summary-only guidance.
13. Internal queued, already-decided, missing-summary, mixed-batch, duplicate, and hard-stop states remain distinct and actionable.
14. `agentRequestsAllowed` global and trusted-project precedence works.
15. Configuration without a recognized permission property defaults to forbidden.
16. `/allow` and `/forbid` remain in memory and never write config.
17. `/run` fails before creating a grant when the public or internal tool is excluded by host selection.
18. `/force` fails before summary when the internal tool is excluded.
19. `/allow` and `/forbid` report permission plus host-level unavailability when the public tool is excluded.
20. Existing preparation, confirmation, continuation, filtering, auto-compaction, bounded retry, synchronous failure, and restoration tests continue to pass.

### `README.md`

Update:

- configuration key and permission semantics;
- always-visible tool behavior;
- authorization as an execute-time gate;
- user and agent messages for forbidden/headless/busy states;
- stable public and internal schemas;
- cache expectations and remaining provider-dependent miss causes;
- host-level explicit tool exclusion behavior.

Remove statements that the public tool is inactive by default, that `/run` or `/allow` exposes it, that forbid removes it, or that the internal decision tool is only active during summary.

### `CHANGELOG.md`

Add unreleased entries for:

- stable always-active public and internal schemas;
- execute-time authorization gates;
- `agentRequestsAllowed` configuration;
- state-specific agent guidance;
- elimination of extension-driven tool-schema changes.

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

1. Both tools are present immediately after startup with default-forbidden configuration.
2. An unauthorized public tool attempt receives the exact user-authorization guidance and starts no dialog or summary.
3. `/run` starts preparation without changing the active tool vector.
4. `/allow` and `/forbid` change permission/status without changing the active tool vector.
5. Authorized execution still opens final confirmation.
6. Decline, cancellation, and revocation give distinct no-retry guidance.
7. Accepted confirmation completes summary and native compaction.
8. `/force` works while public requests are forbidden.
9. The internal tool rejects an out-of-workflow call and works during the canonical summary turn.
10. The active tool vector is unchanged before preparation, during summary, and after settlement.
11. On a session with a reusable long prefix, `/run` and summary-phase entry produce no extension-caused schema change. Record cache observations as provider-dependent evidence, not a guaranteed assertion.
12. Confirm no verification process modified project files.
13. Check for attached tmux clients before cleaning up every verification session.

## Completion and deletion criteria

Delete this plan only after all of the following are true:

1. Both tool schemas are registered eagerly and remain stable.
2. The extension makes no authorization-driven `setActiveTools()` calls.
3. Runtime gates prevent unauthorized public and internal execution.
4. State-specific agent guidance is implemented and tested.
5. Configuration uses `agentRequestsAllowed`; missing, unrecognized, and invalid permission fails closed.
6. Preparation, confirmation, continuation, filtering, retry, cleanup, and compaction regressions pass.
7. README and changelog describe the final behavior without stale dynamic-schema claims.
8. Package and workspace validation pass.
9. Live Pi verification passes, including stable active tools and an accepted compaction workflow.
10. A final review finds no unresolved item, unsupported assumption, or unrelated modification.

Then delete `PLAN.md`, commit the child package with a Conventional Commit, and commit only the updated `packages/pi-supercompact` pointer in the superproject. Do not push or publish.

## Post-compaction continuation directive

After the upcoming compaction, continue this authorized task automatically without requesting approval already given.

Immediate next action:

1. Re-read this entire plan.
2. Revalidate the child and superproject working trees, preserving unrelated `packages/pi-workflow` work.
3. Re-read the current `src/index.ts` and `tests/index.test.ts` before editing.
4. Implement stable schemas and informative state-specific guidance according to this plan.
