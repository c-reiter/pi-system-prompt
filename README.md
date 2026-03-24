# pi-system-prompt

A [pi](https://github.com/badlogic/pi-mono) extension for switching system prompts on the fly.

## Features

- **`/prompt` command** — interactive selector or direct switching (`/prompt researcher`, `/prompt off`)
- **Tab completion** — autocomplete prompt names in the command
- **Footer indicator** — active prompt name shown on the right side of the working directory row
- **Dynamic sections preserved** — skills, project context, date, and cwd are automatically appended from pi's built system prompt
- **Dual directory support** — loads prompts from `~/.pi/agent/prompts/` (global) and `.pi/prompts/` (project-local), with project-local overriding global on name collision
- **Session persistence** — active prompt survives session restarts

## Install

```bash
pi install npm:pi-system-prompt
```

Or via git:

```bash
pi install git:github.com/c-reiter/pi-system-prompt
```

## Usage

```
/prompt              Show interactive selector
/prompt <name>       Switch directly (e.g. /prompt researcher)
/prompt off          Clear custom prompt, restore pi default
```

## Adding Prompt Files

Drop `.md` or `.txt` files into the prompts directory:

```
~/.pi/agent/prompts/       # Global prompts (available everywhere)
.pi/prompts/               # Project-local prompts (override global)
```

The file content becomes the system prompt. Pi's dynamic sections (available skills, project context files, current date, working directory) are automatically appended — you only need to write the instructions part.

## Included Prompts

| File | Description |
|------|-------------|
| `default.md` | Pi's standard system prompt (coding assistant with tools/guidelines/pi docs) |
| `researcher.md` | Research-focused assistant for thorough analysis |

## How It Works

When a prompt is active, the extension intercepts `before_agent_start` and replaces the static head of pi's system prompt with your file content. The dynamic tail — skills XML block, project context, `Current date`, `Current working directory` — is extracted from pi's fully-built prompt and appended automatically.

This means your prompt files stay clean (just instructions) while still getting all of pi's runtime context.

## License

MIT
