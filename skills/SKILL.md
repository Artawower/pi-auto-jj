---
name: pi-jj-auto
description: Automatic jj revision hygiene for pi. Use in jj repositories to keep revisions focused — check revision scope before starting work, handle blocked edits, and follow the decision rules for jj new vs jj desc.
---

# pi-jj-auto: jj Revision Guard

Extends the `jj` skill with an automatic guard on `write`/`edit` tools.

## Proactive check — once per new task

At the start of each new user request, before any work, run once:

```bash
jj log --no-graph -r @ --template 'change_id.short() ++ " | " ++ if(description, description, "(empty)") ++ " | diff:" ++ if(diff.files(), "yes", "no")'
```

Decide based on the result:

| description | diff  | What to do                                                                                               |
| ----------- | ----- | -------------------------------------------------------------------------------------------------------- |
| empty       | any   | Work freely — fresh or WIP revision. Describe it when done.                                              |
| exists      | empty | Work freely — revision just created, not started yet                                                     |
| exists      | yes   | Compare **semantic scope** with current task: same scope → continue; different scope → `jj new -m "..."` |

**Semantic scope** means the logical unit of work — not the exact words. "Add test for login fix" is the same scope as "fix login bug". "Add dark mode" is a different scope.

One check per task is enough. The guard is a fallback for when this step is skipped.

## When the guard blocks your edit

The extension returns `block: true` only when `description` exists **and** `diff` is non-empty:

```
[pi-jj-auto] Revision "fix login bug" already has work.
Your task: "add dark mode"
```

Response:

1. **Different scope** → `jj new -m "add dark mode"` then retry
2. **Same scope, broader** → `jj desc -m "fix login bug + add dark mode"` then retry
3. **Unsure** → create a new revision; it's cheap to merge later with `jj squash`

## Hard rules

- Run the check **once** at the start of each new task — not before every file edit
- If revision description is empty after your changes — describe it: `jj desc -m "<message>"`
- Follow the project's existing commit message style (check `jj log` for examples)
- One revision = one logical change; do not mix unrelated work
- Never use `git commit` or `git add`

## Limitations

- Only `write` and `edit` tools are intercepted — `bash` mutations are not guarded
- Use built-in `write`/`edit` for file changes when the guard matters
