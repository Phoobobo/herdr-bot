# herdr-bot

A team of bots that lives **inside** [herdr](https://herdr.dev) as a plugin overlay TUI.

One **herdr-bot team** owns one **Herdr session**. The default team maps to the default Herdr session (`default`).

When you invoke plugin action **`phoobobo.herdr-bot.bots`** (a keybind, or `herdr plugin action invoke`), the default team resumes and an overlay TUI opens listing the four default members:

| name | tag | body | description |
| ---- | --- | ---- | ----------- |
| 幕僚长 | lead | pi | 管理你的其他 Bot，需要决策时找你 |
| 研发工程师 | eng | pi | You are an awesome software engineer. |
| 研究员 | research | pi | The user works with GitHub every day — start with those tools when suggesting connectors or taking on work. |
| 测试工程师 | qa | pi | You are an awesome Quality Assurance Engineer. |

Those four names are the product gate: resume must return exactly them — extra or missing fails.

## Requirements

- herdr ≥ 0.8.2 with a running server (the default session)
- [bun](https://bun.sh) on the PATH herdr was started with
- macOS or Linux

## Install

Once published:

```bash
herdr plugin install Phoobobo/herdr-bot
```

Then bind a shortcut to plugin action **`phoobobo.herdr-bot.bots`**. That keybind (or `herdr plugin action invoke`) is the only supported entry (same pattern as workboard). Install does **not** change your PATH and you do not need to edit any shell profile.

```toml
[[keys.command]]
key = "prefix+shift+b"
type = "plugin_action"
command = "phoobobo.herdr-bot.bots"
description = "resume herdr-bot team"
```

Or invoke without a keybind:

```bash
herdr plugin action invoke phoobobo.herdr-bot.bots
```

Open the overlay directly:

```bash
herdr plugin pane open --plugin phoobobo.herdr-bot --entrypoint tui --placement overlay --focus
```

GitHub topic: **`herdr-plugin`** (required for the herdr marketplace index).

For local development of this plugin (not the user install path), see [docs/local-dev.md](docs/local-dev.md).

## One team = one session

- Default team id `default` ↔ Herdr session `default` (socket `~/.config/herdr/herdr.sock`).
- Resume never targets other named sessions (for example `taya`).
- Team/bot/channel state lives under `HERDR_PLUGIN_STATE_DIR` (CLI fallback: `~/.local/state/herdr/plugins/phoobobo.herdr-bot`). The default roster is seeded on first run if missing.

## Bot body (harness)

`body` is the installed Herdr integration that runs the bot. Options come from `herdr integration status`; **`not installed` is skipped**. Default body is **`pi`**.

On a machine with the usual integrations that includes at least: `pi`, `omp`, `claude`, `codex`, `copilot`, `opencode`, `hermes`, `grok`.

```bash
herdr-bots bodies list --json
herdr-bots bots body 研发工程师 --body claude
```

## Overlay TUI

The overlay is the Grok Bot layout: a dark sidebar of bots then channels, a main pane that is always a conversation (1:1 DM with a bot, or a #channel thread), and a bottom composer. Type to send, arrows or click to switch, `i` for details (tag / body / description), `q` or Esc to quit. Empty `n` / `c` still create a bot or channel; those letters type into the composer once it has text.

## CLI

```bash
herdr-bots [--json] [--no-open]              # resume default team, open overlay
herdr-bots team show [--json]
herdr-bots bots list [--json]
herdr-bots bots create --name <name> [--tag t] [--description d] [--body pi]
herdr-bots bots rename <id|name> --name <name>
herdr-bots bots tag <id|name> --tag <tag>
herdr-bots bots description <id|name> --description <text>
herdr-bots bots body <id|name> --body <harness>
herdr-bots channel list [--json]
herdr-bots channel create --name <name>
herdr-bots channel post <channel> --from <bot> --text <text>
herdr-bots bodies list [--json]
```

`--json` is the QA surface. `herdr-bots bots list --json` must return exactly the four default names on a fresh state dir.

Plugin actions: `bots`, `create-bot`, `rename-bot`, `set-tag`, `set-description`, `set-body`, `create-channel`.

Manifest id: **`phoobobo.herdr-bot`**.

## Tests

```bash
bun install
bun test
```

## License

Use it. No secrets belong in this repo.


## Live harnesses

The `herdr-bots` workspace keeps **tab 1** for the bots TUI (`bots`). From tab 2, one named tab per person. Each bot tab has three panes, each its own `herdr agent start`:

| pane | agent | role |
| ---- | ----- | ---- |
| `work` | `lead` / `eng` / `research` / `qa` | original work pi (TUI never prompts it) |
| `instant-msg` | `{id}-im` | private 1:1 with the user |
| `channel` | `{id}-ch` | this bot's mouth in the **shared** `#standup` room |

```bash
herdr-bots bots up --json          # ensure the four default members are live
herdr-bots bots live --json        # QA: names must be the four, each live
herdr-bots bots open 研发工程师 --json
```

TUI send uses `herdr agent prompt <target> <text> --wait --timeout 120000` (IM → that bot's `{id}-im`; `#standup` → every member's `{id}-ch`) and writes the reply into the overlay store. `--until` is omitted so herdr's default accepts idle, done, or blocked. If the wait JSON has no message body (herdr 0.8.2), the same session slug is `agent read` and the full assistant reply after the prompt is stored (thinking and Pi footer dropped; wrap fragments joined). There is still **one** `#standup` `messages[]`. The TUI path never prompts work slugs or uses `extractReplyFor`.

```bash
herdr-bots channel create --name standup --json
herdr-bots channel post standup --from 幕僚长 --text "hello team" --json
```
