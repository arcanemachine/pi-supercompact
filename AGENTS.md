# Agent Instructions

## Workflow

Commit when a task is completed.

Do not push or publish unless explicitly authorized.

## Validation

```bash
npm run typecheck
npm run test
npm run build
npm run format
npm pack --dry-run
```

Verify workflow changes against a running Pi session.

## Commit style

Use Conventional Commits:

- `feat: add supercompaction command`
- `fix: preserve continuation directive after compaction`
- `docs: clarify steering queue behavior`
