# pi-supercompact

A power-user [Pi](https://pi.dev) extension that prepares a full-context continuation summary, runs Pi's native compaction, then restores the richer summary and resumes unfinished work when appropriate.

## Workflow

`/supercompact [extra context]` performs three model-assisted steps:

1. Queue a hidden full-context summarization prompt as immediate steering work.
2. Run Pi's normal compaction after the summarization turn settles.
3. Add the visible super-summary after the compaction entry and either continue or wait.

The summary prompt distills the behavior of a practical session-context handoff. It records goals, completed and in-progress work, decisions, concrete paths and commands, verification, blockers, and where to resume. It also returns a structured continuation decision.

The extension uses the currently selected model. It does not load or invoke an external skill.

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

Extra context affects only the super-summary and continuation decision. Pi's native compaction prompt remains unchanged.

## Continuation behavior

The summarization turn selects one action:

- `continue` when extra context explicitly requests continuation, or authorized actionable work remains incomplete and does not require new user input.
- `stop` when extra context requests stopping, work is complete, no actionable work remains, or the agent needs user input or approval.

Explicit command context takes precedence. A `continue` result triggers a new turn after compaction. A `stop` result adds the summary without triggering a turn.

## Queue behavior

When Pi is already responding, `/supercompact` queues its summarization prompt with immediate steering semantics. The current assistant tool batch finishes first, then Pi processes the summary prompt before its next normal continuation.

Other messages retain Pi's native queue behavior. For the most precise compaction boundary, avoid submitting another prompt until supercompaction finishes. Additional messages are not blocked, but they can move compaction later than the command invocation.

A second `/supercompact` is rejected while one is active.

## Native and automatic compaction

The extension does not replace or customize Pi's compaction summary. It calls the native compaction operation with no custom instructions.

Pi may automatically compact after the super-summary turn if that turn crosses the configured threshold. A successful automatic compaction satisfies the workflow's compaction step; the extension does not attempt a redundant second compaction.

## Failure behavior

The workflow is best-effort and leaves the session usable:

- Invalid, aborted, errored, or truncated super-summary output stops the workflow before manual compaction.
- A manual compaction failure prevents final summary injection.
- Errors are reported through Pi notifications rather than thrown into the session.
- If Pi independently auto-compacts before a later workflow error, that native compaction cannot be rolled back.

The intermediate summary response is replaced with a compact transcript line. The full summary is displayed only after successful compaction.

## Requirements

- Pi 0.80.10 or later
- Node.js 22.19.0 or later for package development

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

## License

MIT. See [LICENSE.md](./LICENSE.md).
