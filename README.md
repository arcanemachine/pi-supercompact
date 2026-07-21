# pi-supercompact

A simple [Pi](https://pi.dev) extension that exposes `/supercompact`, a native-compaction workflow designed to preserve the working memory that matters most.

It prepares a full-context continuation handoff, runs Pi's normal compaction, restores the richer handoff invisibly, and conservatively resumes authorized unfinished work when appropriate.

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

## Command

```text
/supercompact
/supercompact run [extra context]
/supercompact allow
/supercompact enable
/supercompact disable
```

`/supercompact` opens a menu. Choosing **Run supercompact now** opens an editor for optional extra context. Explicit `run`, `allow`, `enable`, and `disable` subcommands also work without interactive UI.

Examples:

```text
/supercompact run
/supercompact run continue after compaction
/supercompact run stop after compaction
/supercompact run emphasize verification results and unresolved test failures
```

Extra context affects only the super-summary and continuation decision. Pi's native compaction prompt remains unchanged. When present, the extension echoes the extra context once in its initial notification so the user can confirm it was captured.

### Agent tool authorization

The extension registers an agent-callable `supercompact` tool but keeps it inactive by default:

- `/supercompact allow` exposes the tool for one accepted agent invocation.
- `/supercompact enable` exposes it for repeated use during the current session.
- `/supercompact disable` removes access and cancels an unused one-shot authorization.

A one-shot authorization is consumed when the extension accepts the agent's tool call, even if summarization or compaction later fails. It is not persisted across reloads or session changes. The tool remains schema-active until that supercompaction finishes, avoiding an extra active-tool change before compaction, but execution guards reject duplicate or recursive calls. Enabled mode remains active between workflows.

Direct `/supercompact run` requests are always allowed because the command itself is an explicit user action.

While authorization is active, Pi shows `supercompact: allowed once` or `supercompact: agent enabled` in the status area. The tool definition does not add a prompt snippet or prompt guideline. Activating or explicitly disabling it can still change the provider's active tool schema and may cause a prompt-cache miss; one-shot removal is deferred until after compaction, when conversation context has already changed.

### Configuration

Persistent opt-in uses an extension-specific JSON file:

```json
{
  "agentToolEnabled": true
}
```

The global file is `~/.pi/agent/pi-supercompact.json`. A trusted project may override it with `<project>/.pi/pi-supercompact.json`. The default is `false`; malformed configuration fails closed. The `enable` and `disable` commands override the configured default only for the current session and do not rewrite either file.

## How it works

The extension does not replace or customize Pi's compaction summary. It calls the native compaction operation with no custom instructions.

Pi may automatically compact after the super-summary turn if that turn crosses the configured threshold. A successful automatic compaction satisfies the workflow's compaction step; the extension does not attempt a redundant second compaction.

### Workflow

A user command or authorized agent tool invocation performs four steps:

1. Queue a hidden full-context summarization prompt as immediate steering work.
2. Keep the generated super-summary in the transcript as ordinary assistant Markdown and record a schema-validated `continue` or `stop` decision with a temporary internal tool.
3. Run Pi's normal compaction after the summarization turn settles.
4. Restore the exact summary invisibly after compaction and either continue or wait.

The internal decision tool is active only while the super-summary is being prepared. Its successful call is hidden from the transcript presentation, and it terminates the summarization turn without an acknowledgement round trip. Other tools remain blocked during this dedicated turn.

The currently selected model and authentication are used. The extension does not load or invoke an external skill.

### Summary contents

The prompt treats the newest super-summary as the canonical working-memory handoff. It prioritizes:

- the current objective, direction, authorization boundaries, and state;
- open decisions and blockers;
- verified results separately from mutable observations and unverified information;
- completed history compressed to outcomes and material rationale;
- one concrete next action as the final section.

Files are grouped only when useful under `Needed now`, `Needed for confirmed upcoming work`, and `Durable references`. Each entry gives an exact path and why it matters. The summary does not report historical read status or reproduce a mechanical path ledger, and file references do not instruct the resumed agent to read everything immediately.

When direction changed during the conversation, the summary records the current direction and mentions older direction only when needed to prevent incorrect continuation. It also preserves established non-obvious constraints that affect unfinished work, including explicit prohibitions and source-of-truth or responsibility decisions, without inventing new constraints. Commit hashes, blob hashes, forensic provenance identifiers, and diary-style closed history are omitted.

### Continuation behavior

The summarization turn makes a conservative continuation decision and defaults to `stop` when uncertain:

- `continue` only when the user explicitly requests further work on an identifiable authorized task, or the assistant was actively executing one immediately before supercompaction and has a concrete next action that needs no user input.
- `stop` when work is complete, the assistant delivered a final result, user input or approval is needed, or remaining possibilities are optional, speculative, or unauthorized.

Summary emphasis in extra context does not imply continuation. The model is instructed not to invent or broaden work. On continuation, next actions remain subject to every recorded constraint and do not authorize moving responsibilities or duplicating an existing source of truth. A `continue` result triggers one normal agent turn after compaction; a `stop` result restores the summary without triggering a turn.

Only the newest hidden super-summary is exposed to later model turns. The visible Markdown remains in the transcript, while duplicate summary text and completed internal decision-tool artifacts are filtered from provider context.

### Queue and UI behavior

When Pi is already responding, `/supercompact run` or the authorized agent tool queues its summarization prompt with immediate steering semantics. The current assistant tool batch finishes first, then Pi processes the summary prompt before its next normal continuation.

While the summary is generated, Pi's working indicator shows `Creating super-summary…`. Once the decision is validated, the extension reports whether the agent will continue or wait, restores Pi's default working state, and lets native compaction display its normal loader.

If extra context is supplied, it appears once in the initial notification:

```text
Supercompaction queued; finishing the current tool batch first.
Extra instructions: <extra context>
```

When Pi is idle, the first line is `Creating super-summary.` instead.

Other messages retain Pi's native queue behavior. For the most precise compaction boundary, avoid submitting another prompt until supercompaction finishes. Additional messages are not blocked, but they can move compaction later than the command invocation.

A second supercompact request is rejected while one is active. During the dedicated summary turn, every tool except the internal continuation-decision tool is blocked.

### Failure behavior

The workflow is best-effort and leaves the session usable:

- Invalid decision arguments use Pi's normal tool-error correction loop.
- If the model omits the decision tool, the extension requests it once without asking the model to repeat the summary.
- Summary and metadata attempts are bounded; repeated failures stop the workflow.
- Aborted, errored, truncated, or unusable super-summary output stops the workflow before manual compaction.
- A manual compaction failure prevents final summary injection.
- Every exit path restores Pi's default working message and deactivates the internal tool.
- Errors are reported through Pi notifications rather than thrown into the session.
- If Pi independently auto-compacts before a later workflow error, that native compaction cannot be rolled back.

A successfully generated summary remains visible as a normal assistant message. The exact summary is restored after compaction as a hidden context message, so it remains available to the model without duplicate visible rendering.

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
