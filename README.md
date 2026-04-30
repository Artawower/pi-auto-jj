# pi-jj-auto

Automatic [jj](https://github.com/martinvonz/jj) revision management for [pi](https://pi.dev) coding agent.

## What it does

- 🛡️ **Guards file edits** — blocks `write`/`edit` when the current jj revision already has work
- 🏷️ **Auto-describes** — sets revision description from your prompt when work finishes on an empty revision
- 🤖 **LLM decides** — blocked edits show clear instructions, the model chooses `jj new` or `jj desc`

## Install

```bash
pi install npm:pi-jj-auto
```

## How it works

1. You send a prompt
2. LLM tries to edit a file
3. Extension checks the current jj revision:
   - **Empty description** → pass through (fresh revision)
   - **Description + no diff** → pass through (revision just created via `jj new -m`)
   - **Description + diff** → block with guidance: new task → `jj new -m "..."`, same task → `jj desc -m "..."`
4. LLM runs the right jj command and retries the edit
5. When done, auto-describes the revision from your prompt if description is still empty

## Configuration

Global: `~/.pi/agent/pi-jj-auto.json`  
Project: `.pi/pi-jj-auto.json`

```json
{
  "enabled": true,
  "blockOnMismatch": true,
  "autoDescribe": true,
  "maxPromptLength": 72
}
```

| Field             | Type    | Default | Description                             |
| ----------------- | ------- | ------- | --------------------------------------- |
| `enabled`         | boolean | `true`  | Enable/disable                          |
| `blockOnMismatch` | boolean | `true`  | Block edits or just notify              |
| `autoDescribe`    | boolean | `true`  | Auto-set description on empty revisions |
| `maxPromptLength` | number  | `72`    | Max prompt length for auto-describe     |
