# herdr-bot

A team of bots that lives **inside** [herdr](https://herdr.dev) as a plugin overlay TUI.

One **herdr-bot team** owns one **Herdr session**. The default team maps to the default Herdr session (`default`).

When you invoke plugin action **`phoobobo.herdr-bot.bots`** (a keybind, or `herdr plugin action invoke`), the default team resumes and an overlay TUI opens listing the four default members:

| name | tag | body | description |
| ---- | --- | ---- | ----------- |
| 幕僚长 | lead | grok | 管理你的其他 Bot，需要决策时找你 |
| 研发工程师 | eng | grok | You are an awesome software engineer. |
| 研究员 | research | grok | The user works with GitHub every day — start with those tools when suggesting connectors or taking on work. |
| 测试工程师 | qa | grok | You are an awesome Quality Assurance Engineer. |

Those four names are the product gate: resume must return exactly them — extra or missing fails.

## Requirements

- herdr ≥ 0.8.2 with a running server (the default session)
- [Grok Build](https://x.ai) (`grok` CLI) installed and logged in (`grok login`), with herdr's grok integration installed (`herdr integration install grok`) — the default bot body. `pi` stays available as an optional body.
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

`body` is the installed Herdr integration that runs the bot: `grok` (default) or `pi` (optional). Options come from `herdr integration status`; **`not installed` is skipped**. Other integrations (`omp`, `claude`, `codex`, …) still start, but only `grok` and `pi` have a reply write-back path.

```bash
herdr-bots bodies list --json
herdr-bots bots body 研发工程师 --body pi      # opt one bot back into pi
herdr-bots bots model 研发工程师 --model grok-4.7
```

### grok (default)

Setup, once per machine:

```bash
grok login                         # interactive; herdr-bot never logs in for you
herdr integration install grok     # herdr reports grok session ids + restores with --resume
grok models                        # the bot's model must be listed here
```

- **Model** is per bot (`model`, default **`grok-4.7`**; `bots model <bot> --model <id>`, `bots create … --model <id>`, plugin action `set-model`). Before starting an agent herdr-bot runs `grok models` and fails with `GROK_MODEL` if the id is not listed (a logged-out grok only lists its defaults).
- **Sessions are pinned.** Each pane (`work`, `instant-msg`, `channel`) gets its own grok session UUID stored on the bot (`grok_sessions.work|im|ch`). The first start runs `grok --session-id <uuid> --model <m> --rules <identity>`; once grok has written the session directory, restarts use `grok --resume <uuid> …` so history survives. The identity goes in `--rules` (appended `<human_rules>`), so grok's own system prompt and tools stay intact.
- **Write-back reads grok's structured session log, never the screen.** Grok persists every ACP `session/update` to `$GROK_HOME/sessions/<url-encoded cwd>/<session-id>/updates.jsonl`. herdr-bot records the file's byte offset, sends the prompt with `herdr agent prompt … --wait`, then reads the new lines until `turn_completed`: the reply is the `agent_message_chunk` text of that turn; when the turn made tool calls, only the text **after the last tool call** is kept (narration before a tool call is never stored or shown; thoughts are dropped). The read is bound to the turn whose user text is the prompt just sent, so a turn from another prompt is never mixed in. Multi-line text, code fences and long Chinese are stored byte-for-byte. A turn that ends in `error`/`rate_limit`, has no text (including a turn that ends on a tool call with no text after it), or never completes (for example blocked on a tool approval) raises `GROK_TURN` instead of storing a guess. herdr's `agent_session` (from the grok hook) wins over the pinned id when present.
- Screen sync (`channel sync`, `extractReplyFor`) skips grok bots.
- **One turn at a time per pane.** Prompts to the same slug are serialized (in-process queue + a lock dir under the state dir, so a TUI send and a `herdr-bots dm` from another process also queue). A second message sent before the first reply finishes is delivered after the first turn completes and gets its own reply. Writes to `team.json` take a lock and fold in messages other processes appended meanwhile, so concurrent DMs to different bots never drop one.
- **Folder trust.** On first launch in an untrusted folder grok shows "Do you trust the contents of this directory?", which herdr reports as idle. Trust the bot cwd once (`grok` there and answer `y`), or set `HERDR_BOT_GROK_TRUST=1` so herdr-bot passes grok's `--trust` (persists the grant).

| env | default | purpose |
| --- | ------- | ------- |
| `GROK_BIN_PATH` | `grok` | grok binary used for `grok models` |
| `GROK_HOME` | `~/.grok` | where grok keeps `sessions/` (same variable grok reads) |
| `HERDR_BOT_GROK_MODELS` | — | comma list that replaces `grok models` (tests / offline) |
| `HERDR_BOT_GROK_REPLY_GRACE_MS` | `20000` | how long to wait for `turn_completed` after `agent prompt --wait` returns |
| `HERDR_BOT_GROK_TRUST` | — | `1` adds grok `--trust` to agent starts |
| `HERDR_BOT_CWD` | `/Users/phoobobo/Workspace/herdr-bot` if it exists, else this repo | working directory for bot panes (also grok's session-folder key) |

Existing state from older versions keeps `body: pi` until you switch it: `herdr-bots bots body <bot> --body grok`, then stop the old pi agents and `herdr-bots bots up`.

### pi (optional)

`pi` bots start with `--system-prompt <identity>`; replies come from the wait JSON, or from `herdr agent read` of the same pane (see Live harnesses).

## Overlay TUI

The overlay is the Grok Bot layout: a dark sidebar of bots then channels, a main pane that is always a conversation (1:1 DM with a bot, or a #channel thread), and a bottom composer. Type to send, arrows or click to switch, `i` for details (tag / body / description), `q` or Esc to quit. Empty `n` / `c` still create a bot or channel; those letters type into the composer once it has text.

## CLI

```bash
herdr-bots [--json] [--no-open]              # resume default team, open overlay
herdr-bots team show [--json]
herdr-bots bots list [--json]
herdr-bots bots create --name <name> [--tag t] [--description d] [--body grok|pi] [--model grok-4.7]
herdr-bots bots rename <id|name> --name <name>
herdr-bots bots tag <id|name> --tag <tag>
herdr-bots bots description <id|name> --description <text>
herdr-bots bots body <id|name> --body <harness>
herdr-bots bots model <id|name> --model <grok-model-id>
herdr-bots dm <id|name> --text <text> [--json]   # 1:1 DM; prints the stored reply
herdr-bots channel list [--json]
herdr-bots channel create --name <name>
herdr-bots channel post <channel> --from <bot> --text <text>
herdr-bots bodies list [--json]
```

`--json` is the QA surface. `herdr-bots bots list --json` must return exactly the four default names on a fresh state dir.

Plugin actions: `bots`, `create-bot`, `rename-bot`, `set-tag`, `set-description`, `set-body`, `set-model`, `create-channel`.

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
| `work` | `lead` / `eng` / `research` / `qa` | original work agent (TUI never prompts it) |
| `instant-msg` | `{id}-im` | private 1:1 with the user |
| `channel` | `{id}-ch` | this bot's mouth in the **shared** `#standup` room |

```bash
herdr-bots bots up --json          # ensure the four default members are live
herdr-bots bots live --json        # QA: names must be the four, each live
herdr-bots bots open 研发工程师 --json
```

TUI send uses `herdr agent prompt <target> <text> --wait --timeout 120000` (IM → that bot's `{id}-im`; `#standup` → every member's `{id}-ch`) and writes the reply into the overlay store. `--until` is omitted so herdr's default accepts idle, done, or blocked. **grok** bodies take the reply from that pane's grok session log (`updates.jsonl`, see Bot body). For **pi** bodies, if the wait JSON has no message body (herdr 0.8.2), the same session slug is `agent read` and the full assistant reply after the prompt is stored (thinking and Pi footer dropped; wrap fragments joined). There is still **one** `#standup` `messages[]`. The TUI path never prompts work slugs or uses `extractReplyFor`.

```bash
herdr-bots channel create --name standup --json
herdr-bots channel post standup --from 幕僚长 --text "hello team" --json
```
