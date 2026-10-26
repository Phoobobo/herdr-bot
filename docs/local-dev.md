# Local development

> This page is **only for local development of the herdr-bot plugin itself** (on the maintainer's machine). It is **not** the user install path. Users install with `herdr plugin install Phoobobo/herdr-bot` and enter through plugin action `phoobobo.herdr-bot.bots` (keybind or `herdr plugin action invoke phoobobo.herdr-bot.bots`) — see the [README](../README.md#install).

Convenience for **this machine** only. Other users should not put `bin/herdr` on PATH.

```bash
herdr plugin link /path/to/herdr-bot
cd /path/to/herdr-bot
bun install
bun link                 # puts `herdr-bots` on PATH
# optional local dispatcher so `herdr bots` works here without a zsh function:
export PATH="$HOME/Workspace/herdr-bot/bin:$PATH"
```

`bin/herdr` is a git-style dispatcher kept for local development. It does not patch herdr or replace `~/.local/bin/herdr` (which `herdr update` would clobber). It is **not** the user entry.

- `herdr bots …` → sibling `herdr-bots` (resume default team + overlay; `--no-open` / `--json` / subcommands work)
- any other args → the official `herdr` found later on PATH (the dispatcher directory is skipped so it does not recurse)

On this machine, put the plugin bin **first** on PATH so a new login pane (macOS Herdr panes are login shells) finds the dispatcher instead of `~/.local/bin/herdr`:

```bash
export PATH="$HOME/Workspace/herdr-bot/bin:$PATH"
```

Local install/link can prepend that directory in `~/.zprofile` (after the `~/.local/bin` line, which would otherwise shadow it), `~/.zshenv` (non-login zsh), and `~/.zshrc`. Then:

```bash
herdr bots                    # local-dev: resume default team + open overlay
herdr bots --no-open --json   # local-dev QA: members must be the four default names
herdr session list            # still official herdr
```

`herdr-bots` remains the direct local CLI (like workboard's `herdr-workboard`):

```bash
herdr-bots                 # resume default team + open overlay
herdr-bots bots list --json
herdr-bots team show --json
```

`shell/herdr.zsh` is an optional local fallback if the plugin bin is not first on PATH. `scripts/herdr-bots.sh` is the same CLI via bun if `herdr-bots` is not on PATH.
