# Supercompact preparation workflow plan

## Objective

Change supercompact from an immediate agent-triggered compaction mechanism into a deliberate, user-controlled preparation workflow.

The normal path should give the agent one final opportunity to close authorized work, surface unresolved questions, establish an exact post-compaction direction, and request final user confirmation before compaction. An explicit force path must remain available when context pressure makes another preparation turn undesirable.

## Plan lifecycle and source of truth

This file is the authoritative implementation plan across the upcoming compaction boundary. The restored agent must re-read `PLAN.md` completely before changing implementation files; the super-summary is a navigation aid, not a replacement for this plan.

Lifecycle:

1. Commit `PLAN.md` before compaction so the accepted design cannot be lost with conversational context.
2. Keep the plan present and current throughout implementation, automated validation, documentation updates, and live Pi verification.
3. If implementation reveals a material design conflict, update the plan or ask the user rather than silently diverging from it.
4. After every planned behavior is implemented and verified, re-read the plan and check each required behavior and test category against the final code.
5. Delete `PLAN.md` only after that final plan-to-implementation audit succeeds.
6. Include the plan deletion in the completed feature's child-package commit, then commit the updated submodule pointer in the superproject.

The plan must not be deleted merely because compaction completed. Its deletion is a completion signal for the implementation, not a compaction cleanup step.

## Accepted command model

```text
/supercompact
/supercompact run [extra context]
/supercompact force [extra context]
/supercompact allow
/supercompact forbid
```

### `/supercompact`

Open the command menu with these actions:

1. **Run pre-compaction wrap**
2. **Force supercompaction now**
3. **Allow agent supercompaction requests for this session**
4. **Forbid agent supercompaction requests for this session**
5. Cancel

The run and force menu actions should open the existing multiline editor for optional extra context before proceeding.

### `/supercompact run [extra context]`

Do not compact immediately.

Instead:

1. Create one pending preparation authorization, independent of the session-wide allow/forbid policy.
2. Activate the agent-facing `supercompact` tool if it is not already active.
3. Send a hidden steering message that asks the agent to perform the pre-compaction wrap.
4. Let the agent finish or clarify the current work before it requests compaction.
5. Require final user confirmation when the agent eventually calls the tool.

This command covers the former one-shot `/supercompact allow` use case. There is no separate one-shot allow command.

### `/supercompact force [extra context]`

Immediately start the existing super-summary, native compaction, and continuation-restoration workflow.

This is an explicit user action and therefore bypasses both the preparation wrap and the final confirmation dialog. It is the escape hatch for sessions too close to the context limit to safely spend another model turn preparing.

### `/supercompact allow`

Allow the agent to request supercompaction repeatedly for the current live extension session.

This replaces the previous `/supercompact enable` command. It does not write configuration. Each actual agent-initiated compaction still requires final user confirmation.

### `/supercompact forbid`

Forbid agent-initiated supercompaction requests for the current live extension session.

This replaces the previous `/supercompact disable` command. It must also cancel any unused preparation authorization created by `/supercompact run`. It does not interrupt a native compaction that has already begun and cannot roll one back.

## Configuration and runtime precedence

Keep the existing extension-specific configuration format:

```json
{
  "agentToolEnabled": true
}
```

Configuration locations:

- Global: `~/.pi/agent/pi-supercompact.json`
- Trusted project override: `<project>/.pi/pi-supercompact.json`

Rules:

1. Missing configuration defaults to `agentToolEnabled: false`.
2. A trusted project value overrides the global value.
3. Invalid configuration fails closed and reports a warning when UI is available.
4. `/supercompact allow` and `/supercompact forbid` are in-memory overrides only.
5. Commands never rewrite either configuration file.
6. Reload, restart, new-session, resume, or fork lifecycle initialization discards the in-memory override and reapplies configuration.
7. An explicit `/supercompact run` creates one pending preparation authorization even when the configured or in-memory session policy is forbidden.
8. An explicit `/supercompact force` is always permitted.

## State model

Separate persistent defaults, live-session policy, preparation authorization, confirmation, and active compaction state. Do not overload a single `enabled/once/disabled` variable.

Required state separation (exact local names may vary, but these concerns must remain distinct):

```ts
type AgentPolicy = "allowed" | "forbidden";

let configuredPolicy: AgentPolicy = "forbidden";
let sessionPolicyOverride: AgentPolicy | undefined;
let preparationGrant:
  | {
      id: string;
      extraContext: string;
    }
  | undefined;
let confirmationPending = false;
let request: SupercompactRequest | undefined;
```

Map configuration explicitly: `agentToolEnabled: true` means `configuredPolicy = "allowed"`; `false`, omission, or invalid configuration means `configuredPolicy = "forbidden"`.

Derived effective policy:

```ts
const effectivePolicy = sessionPolicyOverride ?? configuredPolicy;
```

The public tool should be active when any of these holds:

- effective policy is `allowed`;
- a `/supercompact run` preparation grant is pending;
- a consumed one-shot request is still completing and removal is deferred until the workflow settles.

The public tool's `execute` method must remain authoritative. Active-tool visibility is not a security boundary because another extension may alter the active tool set or a provider may return a stale call.

## Pre-compaction wrap prompt

Add a dedicated hidden custom-message type, separate from the existing summary request and restored context types.

The prompt should direct the agent to:

1. Review the current objective, active work, explicit authorization boundaries, and established non-obvious constraints.
2. Identify unfinished or unhandled items that the user already authorized.
3. Complete only work that is currently authorized, safe to complete, and does not require new user input.
4. Avoid inventing work, broadening scope, or treating optional cleanup and speculative improvements as required.
5. Run relevant verification for work it finishes when project rules call for it.
6. Observe repository commit rules; if approval is required before committing, ask rather than assuming.
7. Surface blockers, unanswered questions, missing approvals, credentials, or decisions.
8. If user input is required, ask the user and wait. Do not request supercompaction yet.
9. Establish whether work should continue after compaction or stop.
10. If continuation is intended, identify one exact immediate next action that remains authorized and needs no additional input.
11. When the boundary is clean, call the `supercompact` tool to request final confirmation.
12. Do not call the tool merely because it is available; call it only after the preparation checks are complete.

User-supplied extra context from `/supercompact run` has high priority for the preparation, but cannot authorize unrelated work or bypass existing constraints.

This prompt should adapt the useful pre-check principles from `n-skill wrap` without treating supercompaction as an end-of-session operation. It should not require a full formal wrap-up response when the session is expected to continue.

## Freshen and wrap quality gate

The preparation prompt must incorporate the spirit of both `n-skill freshen` and `n-skill wrap` as a concise quality gate before the agent requests compaction.

### Freshen check

Within the scope of the active work, the agent should:

1. Re-read the relevant plan, user-facing documentation, agent-facing instructions, and directly referenced companion documents instead of trusting conversational memory.
2. Compare those documents with actual repository state, current command names, implementation paths, and focused verification results.
3. Fix obvious staleness introduced by the current work: obsolete status or next-step text, renamed commands, missing durable decisions, and code documentation that no longer reflects behavior.
4. Keep persistent documentation evergreen. Do not write transient branch-ahead counts, commit hashes, push status, diary narration, or other point-in-time details into durable docs.
5. Keep the check narrowly scoped to the active task; do not turn preparation into an unrelated repository-wide documentation audit.

### Wrap check

The agent should then:

1. Check for incomplete requested work, unfinished active items, required validation, required commits, unresolved user questions, and changes left in the wrong place.
2. Resolve issues it is already authorized to resolve.
3. Surface blockers or required decisions prominently and ask the user before proceeding when input is needed.
4. Distinguish real remaining work from optional improvements or speculative follow-ups.
5. State a compact current objective, verified state, authorization boundaries, and exact post-compaction next action.
6. Re-read any document it created or updated and make a final accuracy pass.
7. Request final compaction confirmation only when no unresolved issue or concern makes continuation ambiguous.

The quality gate must preserve substance without forcing a heavyweight ceremonial report. If everything is already clean, the agent may perform the checks silently and proceed directly to the confirmation request.

## Agent tool contract

Keep the public tool name `supercompact`, but change its purpose from immediate execution to a request for final confirmation followed by execution.

Required parameters:

```ts
{
  continuation: "continue" | "stop";
  nextAction: string;
  extraContext?: string;
}
```

Parameter meaning:

- `continuation`: the agent's expected post-compaction behavior after completing the preparation check.
- `nextAction`: one concrete immediate action, or an explicit statement that the agent will wait for the user.
- `extraContext`: optional additional emphasis for the canonical super-summary.

The tool description must state that the agent must finish the preparation checks, resolve or ask about open questions, and know the post-compaction action before calling it.

Do not add `promptSnippet` or `promptGuidelines`; keeping instructions in the tool description and the temporary preparation message avoids unnecessary permanent system-prompt changes.

## Final confirmation

For an agent tool call:

1. Reject the call if a supercompact workflow or another confirmation is already active.
2. Reject the call if neither the effective session policy nor a preparation grant permits it.
3. Set `confirmationPending` synchronously before the first `await` to prevent concurrent calls.
4. Require `ctx.hasUI`; fail closed in print and JSON modes.
5. Show a TUI/RPC confirmation containing:
   - whether the agent intends to continue or stop;
   - the exact proposed next action;
   - supplied extra context, if any;
   - a clear statement that native compaction will begin immediately if confirmed.
6. If the user confirms, begin the existing super-summary workflow.
7. If the user declines a `/run` preparation request, clear that preparation grant and deactivate the tool unless session policy remains allowed.
8. If the user declines while session policy is allowed, clear the specific preparation grant, retain the session-wide policy, and return a result directing the agent not to retry automatically and to wait for user direction.
9. Always clear `confirmationPending` on success, decline, cancellation, thrown errors, shutdown, and session initialization.

The confirmation is the enforceable final user check. The extension should not attempt to infer authorization from a natural-language `yes` in conversation.

## Starting the existing super-summary workflow

After confirmation, combine preparation information into the summary emphasis passed to `buildSummaryPrompt`:

- original `/run` extra context, when present;
- tool-call extra context, when present;
- expected continuation decision;
- exact next action.

Clearly label this material as preparation context. It should strongly shape the summary and continuation decision but must remain subordinate to explicit user instructions and recorded constraints.

Then reuse the current workflow:

1. Queue the hidden full-context summary request.
2. Capture visible Markdown.
3. Record the schema-validated internal `continue` or `stop` decision.
4. Run native compaction.
5. Restore the canonical summary invisibly.
6. Continue or wait according to the validated decision.

The existing internal decision tool remains separate from the public confirmation-request tool.

Continuation intent has asymmetric safety semantics:

- A user-confirmed `stop` is a hard constraint. The internal decision tool must reject and correct any `continue` result.
- A user-confirmed `continue` authorizes continuation but does not force it. The internal decision may conservatively choose `stop` if preparation or summarization reveals missing input, a blocker, completed work, or uncertainty.

The confirmed intent and any conservative downgrade to `stop` must be preserved in the canonical summary so a resumed agent cannot invent authorization or make assumptions about why it is waiting.

## Preparation-message lifecycle

Prevent completed or canceled preparation-control messages from polluting later provider context.

Extend the current `context` filtering so that:

- the active preparation request remains available while the agent is preparing;
- stale preparation requests from prior runs are removed;
- once the public tool call is confirmed and the canonical summary request starts, the preparation control message can be filtered because its durable outcome is carried in the confirmed preparation context;
- ordinary user questions, answers, agent work, verification, and decisions produced during preparation remain in context and are summarized normally.

Only control artifacts should be filtered; do not hide substantive preparation work.

## Queueing and interaction behavior

### When idle

`/supercompact run` should send the hidden preparation message with `triggerTurn: true` and steering delivery so the agent begins its checkpoint immediately.

### While streaming

`/supercompact run` should queue the preparation message with steering semantics. The current tool batch finishes first, then the agent performs the pre-compaction wrap before its next normal continuation.

### User questions during preparation

If the agent asks a question, the preparation grant remains pending while it waits. The user can answer normally. The agent may call the tool on a later turn after the issue is resolved.

### Cancellation

`/supercompact forbid`, session lifecycle replacement, and shutdown clear unused preparation state. When UI is available, explicitly notify the user when a pending preparation is canceled.

## Caching behavior

Maintain the cache-conscious behavior established by the current implementation:

1. Register the public tool at extension load.
2. Keep it inactive when forbidden and no preparation grant exists.
3. `/run` or `/allow` may add the schema and cause one provider-dependent cache miss.
4. Do not temporarily remove the public tool merely to prevent recursion; use state and execution guards.
5. A consumed `/run` grant remains schema-active through summary and native compaction.
6. Remove it only after the workflow settles, unless session policy remains allowed.
7. `/forbid` removes it immediately because explicit revocation takes priority over cache preservation.
8. The existing temporary internal decision tool continues to be activated only for the summary turn.

The hidden preparation message necessarily changes conversation context, but menu, status, in-memory policy, and execution checks do not themselves alter the model prompt.

## Headless behavior

- TUI and RPC modes support the final confirmation dialog.
- `/supercompact force [context]` remains usable in print and JSON modes because the command itself is explicit authorization.
- `/supercompact run` must reject early without dialog-capable UI, rather than start a preparation that cannot be confirmed.
- `/supercompact allow` and `/supercompact forbid` still change in-memory policy in headless modes, but agent tool execution must fail closed without confirmation UI.
- Bare `/supercompact` continues to require TUI or RPC mode because it opens a menu.

## Concurrency and recursion safeguards

1. Keep `executionMode: "sequential"` on the public tool.
2. Set a confirmation lock synchronously before awaiting UI.
3. Recheck permission and active request state inside `execute`.
4. Reject duplicate public tool calls from the same or later batches.
5. Preserve the existing rule that only the internal decision tool may execute during the dedicated summary turn.
6. Reject `/run` when another preparation, confirmation, or compaction request is already active; do not silently replace its context.
7. `force` should reject while another supercompact workflow or confirmation is active.
8. `forbid` must not corrupt an active summary/compaction request; it revokes future agent access and clears only unused preparation state.
9. Every failure path must restore the default working message, clear locks, deactivate the internal decision tool, and reconcile public tool visibility with the remaining session policy.

## User-visible status

Use status text that reflects permission rather than implementation terminology:

- Pending `/run`: `supercompact: preparing`
- Session allowed: `supercompact: allowed`
- Confirmation open: `supercompact: awaiting confirmation`
- Forbidden with no preparation: no status entry

When a session-wide allow and a one-shot preparation coexist, preparation/confirmation status takes display priority.

Notifications should clearly distinguish:

- preparation started or queued;
- agent requests allowed for the live session;
- agent requests forbidden for the live session;
- preparation canceled;
- final confirmation declined;
- actual super-summary started;
- summary or compaction failure.

## Command parsing and compatibility

Replace the current accepted subcommands:

- `run` changes from immediate compaction to preparation.
- `force` becomes the immediate path.
- `allow` changes from one-shot authorization to session-wide permission.
- `enable` is removed.
- `disable` is removed.
- `forbid` becomes the session-wide revocation command.

Update argument completion to exactly:

```text
run
force
allow
forbid
```

Unknown or removed commands should report the new usage string rather than silently retain old behavior:

```text
Usage: /supercompact [run [extra context] | force [extra context] | allow | forbid]
```

Because `allow` changes meaning, documentation and changelog must call out that it is now session-wide. This feature is currently unreleased, so do not retain deprecated aliases for `enable` or `disable`.

## Implementation outline

### `src/index.ts`

1. Add a preparation custom-message type and details shape.
2. Replace `AgentToolMode = "disabled" | "once" | "enabled"` with separate configured/session policy and preparation state.
3. Refactor public-tool activation into a reconciliation function based on derived permission and active workflow state.
4. Split the current shared start function into:
   - `startPreparation` for `/run`;
   - `startSupercompact` for confirmed agent calls and `/force`.
5. Add the pre-compaction wrap prompt builder.
6. Change public tool parameters and description.
7. Add final confirmation with a synchronous concurrency lock.
8. Combine confirmed preparation metadata into summary extra context.
9. Update lifecycle cleanup and context filtering.
10. Replace command menu, parser, completions, status, and notifications.
11. Preserve the internal decision-tool validation, bounded retries, native auto-compaction detection, continuation restoration, and duplicate-summary filtering.

### `tests/index.test.ts`

Extend the harness with confirmation responses and add coverage for the state transitions below.

### `README.md`

Rewrite command, agent authorization, configuration, queue/UI, caching, and failure sections to describe preparation and force behavior.

### `CHANGELOG.md`

Replace the unreleased command descriptions with the finalized vocabulary and preparation workflow.

## Required tests

### Commands and menu

1. Bare command opens the new menu.
2. Menu run opens the context editor and starts preparation, not summary/compaction.
3. Menu force opens the editor and starts the existing summary workflow immediately.
4. Explicit run accepts multiline extra context.
5. Explicit force accepts multiline extra context.
6. Completion exposes only run, force, allow, and forbid.
7. Removed `enable`/`disable`, `allow`/`forbid` with extra arguments, and a legacy bare-context first token report usage errors.
8. Run and menu fail safely without UI; force remains available.

### Configuration and live-session policy

9. Missing config defaults to forbidden.
10. Global true/false is respected.
11. Trusted project config overrides global config.
12. Untrusted project config is ignored.
13. Invalid config fails closed.
14. Allow overrides configured false in memory without writing files.
15. Forbid overrides configured true in memory without writing files.
16. Session initialization/reload discards both overrides and reapplies config.
17. Repeated allow/forbid is idempotent and does not duplicate active tool names.

### Preparation

18. Run creates one preparation grant and sends the wrap prompt with correct idle steering options.
19. Run while busy queues steering without triggering a redundant turn.
20. Run extra context appears once and is included in the preparation prompt.
21. A second run is rejected while preparation is pending.
22. Preparation persists while the agent asks a question and waits.
23. Forbid cancels an unused preparation grant.
24. Session start/shutdown clears preparation and confirmation state.
25. Stale preparation-control messages are removed without removing substantive conversation messages.

### Final confirmation

26. Agent tool calls are rejected while forbidden without a preparation grant.
27. A prepared tool call shows continuation, next action, and extra context in confirmation.
28. Confirmation acceptance starts exactly one summary request.
29. Confirmation decline starts no summary or compaction.
30. Declining a prepared one-shot clears it and removes the tool when generally forbidden.
31. Declining under session-wide allow retains the policy but instructs the agent to wait.
32. Confirmation fails closed without UI.
33. Duplicate or concurrent calls cannot open multiple dialogs or start multiple workflows.
34. A tool call during active summary/compaction is rejected.
35. User-confirmed stop rejects and corrects an internal continue decision.
36. User-confirmed continue may conservatively downgrade to stop when continuation criteria are not satisfied.

### Force path

37. Force starts the existing workflow without preparation or confirmation.
38. Force remains usable while agent requests are forbidden.
39. Force is rejected while preparation confirmation or another compaction is active.
40. Force retains current idle/busy steering and extra-context behavior.

### Workflow and caching-sensitive state

41. A consumed preparation grant remains active through summary and decision validation.
42. It is removed after successful compaction when session policy is forbidden.
43. It is removed after workflow failure when session policy is forbidden.
44. It remains active after success or failure when session policy is allowed.
45. Forbid during preparation removes access immediately.
46. Forbid during active summary revokes future access without corrupting the current request.
47. Internal decision-tool cleanup remains independent of public-tool policy.
48. Existing continuation, auto-compaction, retry-bound, transcript filtering, and failure tests continue to pass.

## Validation

Run package validation:

```bash
npm run typecheck
npm run test
npm run build
npm run format
npm pack --dry-run
```

Run workspace validation from `/workspace/projects/pi`:

```bash
corepack pnpm --filter @arcanemachine/pi-supercompact run typecheck
corepack pnpm --filter @arcanemachine/pi-supercompact run test
corepack pnpm --filter @arcanemachine/pi-supercompact run build
```

Then verify in a running Pi session:

1. Menu labels and editor behavior.
2. Run preparation at idle and while streaming.
3. Agent question/wait behavior during preparation.
4. Confirmation acceptance and decline.
5. Force behavior.
6. Allow/forbid status and config override behavior.
7. Recursion and duplicate-call safeguards.
8. Successful compaction in a session large enough to compact.
9. Cleanup of the verification tmux session after confirming no clients are attached.

## Plan completion and deletion criteria

Before deleting this file, verify all of the following:

1. The accepted run, force, allow, and forbid semantics are implemented.
2. The freshen and wrap quality gate is present in the preparation prompt and is neither vague nor excessively broad.
3. Final confirmation is enforced for agent-triggered compaction in TUI and RPC modes and fails closed without dialog-capable UI.
4. Force remains an immediate explicit-user path.
5. Configuration behavior and in-memory-only overrides match this plan.
6. Preparation artifacts, public tool state, internal decision-tool state, recursion guards, and every failure path clean up correctly.
7. Automated tests cover the state transitions and existing workflow regressions listed above.
8. Package and filtered workspace validation pass.
9. Live Pi verification exercises preparation, questions or waiting, confirmation acceptance and decline, force, allow/forbid, and a real successful compaction.
10. README and changelog describe final behavior rather than the superseded implementation.
11. A final review finds no unresolved plan item, stale documentation, or unsupported assumption.

Only then delete `PLAN.md` and include its deletion with the completed feature.

## Commit sequence

1. Before compaction, commit this plan in the child package and then commit the updated `packages/pi-supercompact` pointer in the superproject.
2. When implementation and live verification are complete, delete `PLAN.md` and commit the child package with a Conventional Commit, for example:

   ```text
   feat: add pre-compaction preparation workflow
   ```

3. Commit the final updated `packages/pi-supercompact` submodule pointer in the superproject.
4. Do not include or modify the unrelated `packages/pi-workflow` work.
5. Do not push or publish without explicit authorization.

## Post-compaction continuation directive

After the upcoming plain supercompaction, continue this authorized task automatically. Do not stop after acknowledging the restored context and do not ask for approval that has already been given.

Immediate next action, owned by the agent:

1. Re-read `packages/pi-supercompact/PLAN.md` completely.
2. Re-read the current `packages/pi-supercompact/src/index.ts` and `packages/pi-supercompact/tests/index.test.ts` before editing, because another agent may have changed repository state across the compaction boundary.
3. Revalidate the child and superproject working trees, preserving unrelated `packages/pi-workflow` work.
4. Implement the preparation workflow in focused stages, using this plan as the source of truth.

Established constraints that remain in force:

- `/supercompact run` prepares, wraps, and grants one pending confirmed use; it does not compact immediately.
- `/supercompact force` immediately invokes the existing super-summary and native compaction workflow.
- `/supercompact allow` and `/supercompact forbid` are live-session, in-memory-only policy overrides and never rewrite configuration.
- The config key remains `agentToolEnabled`, defaults to `false`, and supports global plus trusted-project files.
- Agent-triggered compaction requires final user confirmation.
- The preparation quality gate incorporates focused freshen and wrap checks, asks about real blockers, and preserves an exact post-compaction next action.
- Do not broaden scope, invent requirements, alter `packages/pi-workflow`, push, or publish.
- Keep this plan until implementation, documentation, automated validation, live verification, and final plan audit are complete; then delete it as part of the feature commit.
