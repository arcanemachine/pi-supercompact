# pi-supercompact

A [Pi](https://pi.dev) extension for deliberate, loss-resistant context compaction.

It gives the agent a focused pre-compaction checkpoint, requires final user confirmation for agent requests, prepares a canonical full-context handoff, runs Pi's native compaction, restores the handoff invisibly, and conservatively continues authorized work when appropriate.

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
/supercompact forbid
```

`/supercompact` opens a menu with preparation, force, allow, and forbid actions. Preparation and force open a multiline editor for optional context.

### Prepare normally

```text
/supercompact run
/supercompact run preserve the accepted API boundaries and continue implementation
```

`run` does not compact immediately. It:

1. Creates one pending preparation authorization.
2. Exposes the agent-facing `supercompact` tool.
3. Sends a hidden steering prompt asking the agent to perform a focused pre-compaction wrap.
4. Lets the agent finish already-authorized work, verify it, freshen relevant durable context, or ask required questions.
5. Requires the agent to identify whether work should continue and name one exact next action.
6. Shows a final confirmation dialog when the prepared agent calls the tool.
7. Starts the canonical summary and native compaction only after confirmation.

The preparation prompt incorporates focused freshen and wrap checks without turning the checkpoint into a broad repository audit or ceremonial report. If user input is required, the agent must ask and wait; the preparation authorization remains pending across turns.

### Force immediately

```text
/supercompact force
/supercompact force stop after compaction
```

`force` immediately starts the canonical summary and native compaction workflow. It bypasses preparation and final confirmation because the command itself is explicit user authorization. Use it when context pressure makes another preparation turn undesirable.

### Live-session agent policy

- `/supercompact allow` permits repeated agent requests for the current live extension session.
- `/supercompact forbid` revokes that permission and cancels an unused `run` preparation.

These commands change in-memory policy only. They never write configuration. Reloading, restarting, starting, resuming, or forking a session discards the override and reapplies configuration.

Every agent-initiated request still requires a final TUI or RPC confirmation, including requests made while session policy is allowed. Declining tells the agent not to retry automatically and to wait for user direction.

## Configuration

Persistent startup policy uses an extension-specific JSON file:

```json
{
  "agentToolEnabled": true
}
```

The global file is `~/.pi/agent/pi-supercompact.json`. A trusted project may override it with `<project>/.pi/pi-supercompact.json`.

The default is `false`. Malformed configuration fails closed. Project configuration is ignored for untrusted projects.

## How it works

The extension does not replace or customize Pi's native compaction summary. It calls native compaction without custom instructions after creating its own canonical working-memory handoff.

Pi may automatically compact after the canonical summary turn if that turn crosses the configured threshold. A successful automatic compaction satisfies the workflow; the extension does not compact twice.

### Preparation and confirmation

The hidden preparation prompt asks the agent to:

- re-read the relevant plan, user documentation, agent instructions, and directly referenced documents;
- compare them with scoped repository and verification state;
- complete only safe, already-authorized work that needs no new input;
- identify unfinished work, required validation or commits, blockers, questions, approvals, and decisions;
- distinguish required work from optional or speculative follow-ups;
- establish `continue` or `stop` and one exact immediate next action;
- request compaction only when the boundary is clean and unambiguous.

The confirmation dialog shows the expected continuation, proposed next action, and supplied context. The extension sets its confirmation lock before opening the dialog and rechecks authorization afterward, so concurrent requests and revocation while the dialog is open fail safely.

A confirmed `stop` is a hard constraint. A confirmed `continue` is permission, not a mandate: the summary decision may conservatively downgrade to `stop` if work is complete, blocked, missing input, or uncertain. Confirmed intent and any downgrade are restored deterministically with the canonical context.

### Canonical summary workflow

After force or accepted confirmation, the extension:

1. Queues a hidden full-context summarization prompt as immediate steering work.
2. Keeps the generated handoff in the transcript as ordinary assistant Markdown.
3. Records a schema-validated `continue` or `stop` decision using a temporary internal tool.
4. Runs Pi's native compaction after the summary turn settles.
5. Restores the exact handoff invisibly with confirmed preparation metadata.
6. Continues once or waits according to the validated decision.

The internal decision tool is active only during the dedicated summary turn. Other tools are blocked during that turn. Its successful call is hidden from transcript presentation and terminates the turn without an acknowledgement round trip.

### Summary contents

The prompt prioritizes:

- the current objective, direction, authorization boundaries, and actionable state;
- open decisions and blockers;
- verified results separately from mutable observations and reported information;
- completed history compressed to outcomes and material rationale;
- one concrete next action as the final section.

Useful files are grouped by work horizon rather than reproduced as a mechanical ledger. Direction changes and non-obvious constraints are retained only when they affect continuation. The model is instructed not to invent work, broaden scope, include transient hashes, or treat optional follow-ups as authorized.

### Queue, status, and caching

When Pi is idle, preparation and summary messages trigger an immediate steering turn. While Pi is responding, they are queued with steering semantics so the current tool batch finishes first.

Status text is shown only when useful:

- `supercompact: preparing`
- `supercompact: awaiting confirmation`
- `supercompact: allowed`

The public tool is registered once and inactive by default. `run` or `allow` may change the provider's active tool schema and cause one prompt-cache miss. A consumed preparation keeps the tool schema active through summary and native compaction, then removes it after settlement unless session policy is allowed. `forbid` revokes it immediately. Execution guards, rather than temporary schema removal, prevent recursion.

Completed or canceled preparation-control messages, stale summary requests, duplicate restored summaries, and completed internal decision artifacts are filtered from later provider context. Substantive preparation work and ordinary conversation remain available.

### Headless behavior

- TUI and RPC modes support the confirmation dialog.
- `force` works in print and JSON modes because it is explicit authorization.
- `run` rejects before preparation when confirmation UI is unavailable.
- `allow` and `forbid` still change in-memory policy headlessly, but agent execution fails closed without confirmation UI.
- The bare menu requires TUI or RPC mode.

### Failure behavior

The workflow is bounded and leaves the session usable:

- Concurrent preparation, confirmation, and compaction requests are rejected.
- Revocation or lifecycle replacement while confirmation is open prevents compaction.
- Invalid decision arguments use Pi's normal correction loop.
- If the model omits the decision tool, the extension requests metadata once without repeating the summary.
- Summary and metadata retries are bounded.
- Aborted, errored, truncated, or unusable summaries stop before manual compaction.
- Native compaction failure prevents final context restoration.
- Every exit path restores Pi's working message, clears confirmation and decision state, and reconciles public tool visibility.
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
