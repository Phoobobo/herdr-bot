# herdr-bot: map the product command `herdr bots` onto `herdr-bots`.
#
# Herdr 0.8.x has no plugin CLI subcommands, and wrapping ~/.local/bin/herdr
# would be clobbered by `herdr update`. This function is the non-destructive
# shim: source it from ~/.zshrc. It does not replace the herdr binary.
herdr() {
  if [[ "${1:-}" == "bots" ]]; then
    shift
    if command -v herdr-bots >/dev/null 2>&1; then
      command herdr-bots "$@"
    else
      local _root="${HERDR_BOT_ROOT:-}"
      if [[ -z "$_root" ]]; then
        _root="${0:A:h:h}"
        if [[ ! -f "$_root/src/cli.ts" ]]; then
          _root="$HOME/Workspace/herdr-bot"
        fi
      fi
      command bun run "$_root/src/cli.ts" "$@"
    fi
    return $?
  fi
  command herdr "$@"
}
