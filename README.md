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
/supercompact [extra context]
```

Examples:

```text
/supercompact
/supercompact continue after compaction
/supercompact stop after compaction
/supercompact emphasize verification results and unresolved test failures
```

Extra context affects only the super-summary and continuation decision. Pi's native compaction prompt remains unchanged. When present, the extension echoes the extra context once in its initial notification so the user can confirm it was captured.

## How it works

The extension does not replace or customize Pi's compaction summary. It calls the native compaction operation with no custom instructions.

Pi may automatically compact after the super-summary turn if that turn crosses the configured threshold. A successful automatic compaction satisfies the workflow's compaction step; the extension does not attempt a redundant second compaction.

### Workflow

`/supercompact [extra context]` performs four steps:

1. Queue a hidden full-context summarization prompt as immediate steering work.
2. Keep the generated super-summary in the transcript as ordinary assistant Markdown and record a schema-validated `continue` or `stop` decision with a temporary internal tool.
3. Run Pi's normal compaction after the summarization turn settles.
4. Restore the exact summary invisibly after compaction and either continue or wait.

The internal decision tool is active only while the super-summary is being prepared. Its successful call is hidden from the transcript presentation, and it terminates the summarization turn without an acknowledgement round trip. Other tools remain blocked during this dedicated turn.

The currently selected model and authentication are used. The extension does not load or invoke an external skill.

### Summary contents

The prompt treats the newest super-summary as the canonical working-memory handoff. It prioritizes:

- the current objective and exact next action;
- authorization boundaries and approved decisions;
- current state, open decisions, and blockers;
- verified results separately from mutable observations and unverified claims;
- a focused, explicitly non-exhaustive list of continuation-important files;
- completed history compressed to outcomes and material rationale.

File read completeness is recorded only when genuinely known. Commit hashes, blob hashes, forensic provenance identifiers, and diary-style closed history are omitted.

Pi's native compaction may separately retain a broader mechanical ledger of paths used by file tools. A ledger entry does not guarantee that a read was complete, that exact contents remain active after compaction, or that a file is unchanged. The restored handoff directs the resumed agent to make targeted rereads when exact contents matter, rather than rereading everything or repeating completed investigation.

### Continuation behavior

The summarization turn makes a conservative continuation decision and defaults to `stop` when uncertain:

- `continue` only when the user explicitly requests further work on an identifiable authorized task, or the assistant was actively executing one immediately before supercompaction and has a concrete next action that needs no user input.
- `stop` when work is complete, the assistant delivered a final result, user input or approval is needed, or remaining possibilities are optional, speculative, or unauthorized.

Summary emphasis in extra context does not imply continuation. The model is instructed not to invent or broaden work. A `continue` result triggers one normal agent turn after compaction; a `stop` result restores the summary without triggering a turn.

Only the newest hidden super-summary is exposed to later model turns. The visible Markdown remains in the transcript, while duplicate summary text and completed internal decision-tool artifacts are filtered from provider context.

### Queue and UI behavior

When Pi is already responding, `/supercompact` queues its summarization prompt with immediate steering semantics. The current assistant tool batch finishes first, then Pi processes the summary prompt before its next normal continuation.

While the summary is generated, Pi's working indicator shows `Creating super-summary…`. Once the decision is validated, the extension reports whether the agent will continue or wait, restores Pi's default working state, and lets native compaction display its normal loader.

If extra context is supplied, it appears once in the initial notification:

```text
Supercompaction queued; finishing the current tool batch first.
Extra instructions: <extra context>
```

When Pi is idle, the first line is `Creating super-summary.` instead.

Other messages retain Pi's native queue behavior. For the most precise compaction boundary, avoid submitting another prompt until supercompaction finishes. Additional messages are not blocked, but they can move compaction later than the command invocation.

A second `/supercompact` is rejected while one is active.

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
