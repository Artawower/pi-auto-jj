---
name: pi-jj-auto
description: jj revision hygiene for pi. Use in jj repositories — check revision scope before writing, run jj new for unrelated work, describe revisions after changes.
---

# pi-jj-auto: jj Revision Hygiene

## Before the first file change — check once

```bash
jj log --no-graph -r @ --template 'change_id.short() ++ " | " ++ if(description, description, "(empty)") ++ " | diff:" ++ if(diff.files(), "yes", "no")'
```

## Decision table

| description | diff | What to do                                                                                  |
| ----------- | ---- | ------------------------------------------------------------------------------------------- |
| `(empty)`   | no   | Work freely. After the first write/edit run: `jj describe -m "<what you actually changed>"` |
| `(empty)`   | yes  | Stop. Run `jj describe -m "<summary>"` or `jj new -m "<summary>"` first.                    |
| exists      | no   | Check scope. Different task → `jj new -m "<summary>"` before writing.                       |
| exists      | yes  | Check scope. Same work → continue. Different → `jj new -m "<summary>"` before writing.      |

## Semantic scope

Same scope: "add test for login fix" and "fix login bug".  
Different scope: "add dark mode" and "fix login bug".  
When unsure — `jj new`. Cheap to squash later: `jj squash`.

## After writing to a fresh revision

```bash
jj describe -m "<short summary of the actual change>"
```

Describe the actual change, not the user request verbatim.

## When the extension blocks

```
[pi-jj-auto] Revision has uncommitted changes but no description.
```

Same task → `jj describe -m "<summary>"` then retry.  
Different task → `jj new -m "<summary>"` then retry.

## Hard rules

- One revision = one logical change
- Never use `git commit` or `git add`
