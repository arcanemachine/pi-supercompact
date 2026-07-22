# pi-supercompact

A [Pi](https://pi.dev) extension for deliberate, loss-resistant context compaction.

It provides a focused pre-compaction checkpoint, configurable final confirmation for agent requests, a canonical full-context handoff, Pi native compaction, invisible handoff restoration, and conservative continuation of authorized work. Configuration or an explicit live-session mode can waive only the final confirmation dialog.

## Requirements

- Pi 0.80.10 or later
- Node.js 22.19.0 or later for package development

## Installation

From GitHub:

```bash
pi install git:github.com/arcanemachine/pi-supercompact
```

From npm after publication:

```bash
pi install npm:@arcanemachine/pi-supercompact
```

For local development:

```bash
pi -e ./src/index.ts
```

## Commands

```text
/supercompact
/supercompact run [extra context]
/supercompact force [extra context]
/supercompact allow
/supercompact allow-noconfirm
/supercompact deny
/supercompact abort
```

`/supercompact` opens a menu with preparation, force, confirmation-required allow, no-confirm allow, deny, and abort actions. Preparation and force open a multiline editor for optional context.

### Prepare normally

```text
/supercompact run
/supercompact run preserve the accepted boundaries and continue implementation
```

`run` does not compact immediately. It:

1. Creates one pending preparation authorization.
2. Sends a hidden steering prompt for a focused refresh-and-close checkpoint.
3. Lets the agent finish already-authorized work that needs no new input, refresh relevant durable context, and verify or persist work when applicable.
4. Requires the agent to surface blockers or questions, choose whether work should continue, and name one exact next action.
5. Uses the configured global confirmation default, unless an explicit live-session `allow` or `allow-noconfirm` mode selects the behavior.
6. Starts the canonical summary and native compaction after confirmation or no-confirm authorization.

The checkpoint follows the active session's scope and rules. It does not assume that every session has a repository, files to edit, validation to run, or changes to commit.

If user input is required, the agent asks and waits. The one-off authorization remains pending across turns until it is used, canceled, denied, or replaced by session lifecycle activity.

### Force immediately

```text
/supercompact force
/supercompact force stop after compaction
```

`force` immediately starts the canonical summary and native compaction workflow. It bypasses preparation and final confirmation because the command itself is explicit user authorization. It remains available when agent requests are denied.

### Abort before native compaction

```text
/supercompact abort
```

`abort` cancels pending preparation, an open confirmation, or queued or active canonical-summary work before native compaction begins. It preserves configured and live-session permission and does not change either tool schema. Calling it with no abortable workflow reports `No supercompaction is active.` as an error.

Pi does not expose native compaction cancellation to extensions. Once native compaction begins, press Escape in the TUI or use the host's native cancellation mechanism when available.

### Live-session request permission

- `/supercompact allow` permits agent requests with final confirmation for the current live extension session.
- `/supercompact allow-noconfirm` permits agent requests without the final confirmation dialog for the current live extension session.
- `/supercompact deny` revokes either mode and cancels an unused preparation or open confirmation.

These commands update in-memory permission only and never write configuration. Starting, reloading, resuming, or forking a session discards the override and reapplies configured denied, confirmation-required, or no-confirm permission.

Confirmation-required permission lets an agent request supercompaction but still requires final TUI or RPC confirmation. No-confirm permission is stronger authorization: an agent request may queue the canonical summary and native compaction without another approval prompt. It skips only the dialog; preparation expectations, exact-next-action validation, concurrency and host-tool checks, summary validation, continuation constraints, bounded retries, compaction, filtering, restoration, and cleanup remain enforced.

A declined, canceled, revoked, busy, denied, unavailable, or confirmation-required headless request tells the agent what must happen next and not to retry automatically.

## Configuration

Persistent confirmation and request permission use an extension-specific JSON file:

```json
{
  "requireConfirmation": true,
  "agentRequestsAllowed": true,
  "agentRequestsRequireConfirmation": false
}
```

The global file is `~/.pi/agent/pi-supercompact.json`. A trusted project may override it with `<project>/.pi/pi-supercompact.json`; a recognized project configuration is one complete overriding policy rather than a property-by-property merge. Project configuration is ignored for untrusted projects.

- `requireConfirmation` is the global confirmation default and defaults to `true`. It governs prepared `run` requests when no explicit allowed session mode selects the behavior.
- `agentRequestsAllowed` defaults to `false` and is the only property that grants persistent agent-request permission.
- `agentRequestsRequireConfirmation` governs config-authorized agent requests. When omitted, it inherits `requireConfirmation`.

With no live-session override:

| `requireConfirmation` | `agentRequestsRequireConfirmation` | Prepared `run` | Config-authorized request |
| --------------------- | ---------------------------------- | -------------- | ------------------------- |
| `true`                | omitted                            | Confirm        | Confirm                   |
| `false`               | omitted                            | No confirm     | No confirm                |
| `false`               | `true`                             | No confirm     | Confirm                   |
| `true`                | `false`                            | Confirm        | No confirm                |

`/supercompact allow` and `/supercompact allow-noconfirm` explicitly override confirmation behavior for authorized agent-tool execution during the live session. `/supercompact deny` blocks unprepared requests but does not prevent the user from creating a later one-off `run` grant. `/supercompact force` always remains immediate and dialog-free.

Missing request permission remains denied. Confirmation properties never grant permission. A recognized property with a non-boolean value makes that configuration invalid; invalid configuration fails closed to denied requests with confirmation required and warns when UI is available.

## Stable tools and authorization

The extension registers these tools once when it loads and keeps their schemas active throughout the extension session:

- `supercompact` — the public request interface
- `record_supercompact_decision` — internal canonical-summary workflow control

Tool visibility does not grant authority. The public tool checks effective session permission or an unused `run` grant, workflow and confirmation state, internal-tool availability, exact-next-action validity, UI capability when the active mode requires it, and authorization again at the last applicable boundary. The internal tool accepts a call only during the canonical-summary phase with a valid non-empty handoff, exactly one decision call, no other tool calls, and all confirmed stop constraints intact.

The extension never changes Pi's active tool selection to enforce permission. If the user or host excludes a required extension tool, the extension respects that choice. `run` and `force` fail before creating workflow state when required tools are unavailable, and explain that the tool must be re-enabled or the extension reloaded with its tools available. `allow`, `allow-noconfirm`, and `deny` still update in-memory permission while reporting that execution remains unavailable. `abort` never changes the active tool selection.

## How it works

The extension does not replace or customize Pi's native compaction summary. It creates its own canonical working-memory handoff, then calls native compaction without custom instructions.

Pi may automatically compact after the canonical summary turn if that turn crosses the configured threshold. A successful automatic compaction satisfies the workflow, so the extension does not compact twice.

### Preparation and confirmation

The hidden preparation prompt asks the agent to:

- re-read applicable plans, instructions, user-facing documentation, and directly referenced durable sources;
- compare them with actual scoped state and focused verification when applicable;
- correct scoped staleness without broadening the task;
- finish only authorized work that needs no new input;
- surface blockers, questions, approvals, credentials, or decisions;
- verify or persist completed work when applicable and follow scoped rules;
- establish `continue` or `stop` and one exact immediate next action.

The confirmation dialog is a compact preview. Each displayed freeform value—the next action, preparation context, and additional summary context—is whitespace-normalized and limited to the first 10 words plus `…` when longer. Major blocks are separated by one blank line. The complete values remain unchanged in workflow state, the canonical summary prompt, restored context, and continuation metadata.

When confirmation is required, the extension locks it before opening the dialog and rechecks authorization afterward. Configured, prepared-run, or live-session no-confirm permission opens no dialog and begins the same guarded canonical-summary path directly. A confirmed or explicitly authorized `stop` is a hard constraint. A `continue` choice is permission, not a mandate: the summary decision may conservatively choose `stop` when work is complete, blocked, awaiting input, or uncertain.

### Canonical summary workflow

After force, accepted confirmation, or an authorized no-confirm request, the extension:

1. Queues a hidden full-context summarization prompt as steering work.
2. Keeps the generated handoff in the transcript as ordinary assistant Markdown.
3. Records a schema-validated `continue` or `stop` decision through the internal tool.
4. Runs Pi's native compaction after the summary turn settles.
5. Restores the exact handoff invisibly with authorized preparation metadata.
6. Continues once or waits according to the validated decision.

During the dedicated summary turn, runtime guards block all other tools and reject internal calls outside the required workflow phase. Successful internal control calls are hidden from transcript presentation and terminate the turn without an acknowledgement round trip.

When the decision is recorded, the extension shows the continue-or-wait outcome once as a durable TUI transcript entry. The entry remains available in scrollback instead of disappearing like a transient notification. It is TUI-only session data: it does not enter model context, trigger another turn, or change the provider prompt prefix.

### Summary contents

The prompt prioritizes:

- the current objective, direction, authorization boundaries, and actionable state;
- open decisions and blockers;
- verified results separately from mutable observations and reported information;
- completed history compressed to outcomes and material rationale;
- one concrete next action as the final section.

Relevant resources are grouped by work horizon. Exact file paths remain available when files materially affect continuation. The model is instructed not to invent work, broaden scope, include transient identifiers, or treat optional follow-ups as authorized.

### Queue, status, and caching

When Pi is idle, preparation and summary messages trigger an immediate steering turn. While Pi is responding, they are queued with steering semantics so the current tool batch finishes first.

Operational status text is shown while the extension is preparing or awaiting confirmation:

- `supercompact: preparing`
- `supercompact: awaiting confirmation`

Explicit live-session permission overrides add one of these status items:

- `supercompact: allowed`
- `supercompact: allowed without confirmation`

Configured permission is intentionally silent in the status area. `/deny` clears any live-session permission status, while a later `/allow` or `/allow-noconfirm` displays the new explicit override.

`run`, `allow`, `allow-noconfirm`, `deny`, `abort`, confirmation, no-confirm execution, summary entry, settlement, and cleanup do not change the extension's active tool vector. This removes extension-caused mid-session schema invalidation and preserves an otherwise reusable prompt-cache prefix.

It does not guarantee provider cache hits. Cache expiration, provider policy, model changes, unrelated extensions, host tool selection, system-prompt changes, and conversation-prefix differences can still cause misses.

Completed or canceled preparation-control messages, stale summary requests, duplicate restored summaries, and completed internal decision artifacts are filtered from later provider context. Substantive preparation work and ordinary conversation remain available.

### Headless behavior

- TUI and RPC modes support the final confirmation dialog.
- `force` works in print and JSON modes because it is explicit authorization.
- `run` stops before preparation when its effective confirmation mode requires UI; configured or live-session no-confirm mode works headlessly.
- `allow`, `allow-noconfirm`, and `deny` update in-memory permission headlessly.
- Confirmation-required agent execution fails closed without confirmation UI; no-confirm execution works headlessly while retaining every non-dialog guard.
- The bare menu requires TUI or RPC mode.

### Failure behavior

The workflow is bounded and leaves the session usable:

- Concurrent preparation, confirmation, and compaction requests receive state-specific guidance.
- Revocation or lifecycle replacement while confirmation is open prevents compaction.
- Invalid decision arguments use Pi's normal correction loop.
- If the model omits decision metadata, the extension requests it once without repeating the summary.
- Summary and metadata retries are bounded.
- `/supercompact abort` cancels extension-controlled work before native compaction; idle use reports an error.
- Aborted, errored, truncated, or unusable summaries stop before manual compaction.
- Native compaction failure prevents final context restoration, and active native compaction must be canceled through Escape or the host.
- Queueing and compaction failures preserve the specific reason and do not retry automatically.
- Every exit path restores Pi's working message and clears confirmation and decision state without changing tool schemas.
- Native compaction that already completed cannot be rolled back.

## Development

```bash
npm install --ignore-scripts --workspaces=false
npm run typecheck
npm run test
npm run build
npm run format
npm pack --dry-run
```

The package is source-loaded by Pi from `src/index.ts`; no compiled runtime artifact is required.
