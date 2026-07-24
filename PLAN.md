# One-shot no-confirm permission plan

## Objective

Add `/supercompact allow-noconfirm-once` so the user can arm exactly one agent-requested supercompaction without a final confirmation dialog, while preserving every other workflow guard and automatically exposing the permission state that was effective before the one-shot grant.

## Required behavior

- Treat the one-shot grant as a temporary overlay. Do not mutate `configuredPermission` or `sessionPermissionOverride`, so consuming or canceling it naturally reveals the prior configured or live-session state.
- The command only arms permission; it does not send a preparation message or start compaction. The user can subsequently tell the agent to perform the normal focused preparation and request supercompaction.
- Permit the one-shot overlay over denied or confirmation-required configured/session permission.
- If permission is already effectively `allowed-noconfirm` through configuration or `/supercompact allow-noconfirm`, do not arm a redundant grant. Show a warning explaining that requests already bypass confirmation.
- Refuse or warn without changing state when another preparation, confirmation, summary, or compaction workflow is active.
- Consume the grant only after a valid agent request successfully queues the canonical-summary workflow. Validation, busy-state, unavailable-tool, and queueing failures must not consume it. Once queued, later aborts or failures must not re-arm it.
- While armed, show `supercompact: allow-noconfirm-once 🗜️ `. After consumption or cancellation, restore the status implied by the existing live-session override; configured permission remains intentionally silent.
- Clear an unused one-shot grant on reload, new/resumed/forked session lifecycle, `/supercompact deny`, `/supercompact abort`, and explicit superseding permission/workflow commands. Do not persist it as a custom session entry.
- Keep `/supercompact force` immediate and dialog-free, `/supercompact run` preparation semantics unchanged, and the public/internal tool schemas stable.
- Identify this authorization in summary and restored continuation metadata as one-shot no-confirm permission.
- Support TUI, RPC, and headless modes consistently with existing no-confirm behavior.

## Implementation

1. Add explicit in-memory one-shot grant state with a unique identity so authorization can be rechecked immediately before execution.
2. Extend authorization resolution and labels with a one-shot no-confirm source. Give the armed grant precedence over the underlying configured or session permission.
3. Add helpers to arm, consume, and cancel the grant without modifying the underlying permission values.
4. Integrate cancellation and status updates into lifecycle handlers and the existing `run`, `force`, `allow`, `allow-noconfirm`, `deny`, and `abort` paths.
5. Add `allow-noconfirm-once` to command parsing, usage text, argument completion, and the interactive menu.
6. Update `README.md` and `CHANGELOG.md` with the command, exact consumption boundary, restoration behavior, redundancy warning, lifecycle behavior, status, and headless semantics.

## Tests

Cover at least:

- command parsing, usage, autocomplete, and menu selection;
- arming over configured denial, explicit denial, and confirmation-required permission;
- redundancy under configured and live-session no-confirm permission;
- successful one-time consumption followed by restoration of configured denied, configured confirmation-required, explicit denied, and explicit confirmation-required states;
- invalid arguments, unavailable tools, busy state, and queueing failure leaving the grant armed;
- abort, deny, superseding commands, reload, and session replacement clearing an unused grant;
- headless execution, authorization metadata/labels, status transitions, and stable active tool schemas.

## Validation and delivery

1. Run `npm run format`.
2. Run `npm run typecheck`.
3. Run the package Vitest suite with captured output and verify the pass count.
4. Run `npm run build`.
5. Run `npm pack --dry-run`.
6. Verify the command and one-shot restoration behavior against a running Pi session.
7. Review `git diff --check` and the final scoped diff.
8. Delete `PLAN.md` after implementation and validation are complete.
9. Commit the finished package work with a Conventional Commit message; do not include `PLAN.md` in that finished-work commit.
10. Commit the updated `packages/pi-supercompact` submodule pointer in the superproject. Do not push or publish.
