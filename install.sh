#!/usr/bin/env bash
# Install omp-delegate for Claude Code at user level.
#
#   ./install.sh            plugin install from this checkout (marketplace "omp-tools") + omp-task CLI
#   ./install.sh --link     dev mode: symlink this checkout into ~/.claude/skills (edits apply live)
#   ./install.sh --cli      only put omp-task on PATH (~/.local/bin)
#   ./install.sh --uninstall
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN=omp-delegate
MARKETPLACE=omp-tools
BIN_DIR="${OMP_TASK_BIN_DIR:-$HOME/.local/bin}"
SKILLS_LINK="$HOME/.claude/skills/$PLUGIN"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/claude-omp"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }

check_deps() {
  command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
  command -v omp >/dev/null || warn "omp not found on PATH — install it before delegating (https://github.com/can1357/oh-my-pi)"
}

install_cli() {
  mkdir -p "$BIN_DIR"
  ln -sfn "$REPO/skills/delegate/scripts/omp-task" "$BIN_DIR/omp-task"
  say "linked $BIN_DIR/omp-task"
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "$BIN_DIR is not on PATH" ;; esac
}

seed_config() {
  if [[ ! -e "$CONFIG_DIR/config.json" ]]; then
    mkdir -p "$CONFIG_DIR"
    cp "$REPO/config.example.json" "$CONFIG_DIR/config.json"
    say "created $CONFIG_DIR/config.json (edit presets to taste)"
  fi
}

install_plugin() {
  command -v claude >/dev/null || { echo "claude CLI not found" >&2; exit 1; }
  if [[ -L "$SKILLS_LINK" ]]; then rm "$SKILLS_LINK"; say "removed dev link $SKILLS_LINK"; fi
  claude plugin marketplace add "$REPO" --scope user || claude plugin marketplace update "$MARKETPLACE"
  claude plugin install "$PLUGIN@$MARKETPLACE" --scope user || claude plugin update "$PLUGIN@$MARKETPLACE"
  say "installed $PLUGIN@$MARKETPLACE — run /reload-plugins in open sessions"
}

install_link() {
  mkdir -p "$(dirname "$SKILLS_LINK")"
  if [[ -e "$SKILLS_LINK" && ! -L "$SKILLS_LINK" ]]; then
    echo "$SKILLS_LINK exists and is not a symlink; refusing to replace it" >&2; exit 1
  fi
  ln -sfn "$REPO" "$SKILLS_LINK"
  say "linked $SKILLS_LINK -> $REPO (loads as $PLUGIN@skills-dir)"
}

uninstall() {
  [[ -L "$SKILLS_LINK" ]] && rm "$SKILLS_LINK" && say "removed $SKILLS_LINK"
  [[ -L "$BIN_DIR/omp-task" ]] && rm "$BIN_DIR/omp-task" && say "removed $BIN_DIR/omp-task"
  if command -v claude >/dev/null; then
    claude plugin uninstall "$PLUGIN@$MARKETPLACE" --scope user 2>/dev/null && say "uninstalled plugin" || true
    claude plugin marketplace remove "$MARKETPLACE" 2>/dev/null && say "removed marketplace" || true
  fi
  say "kept ${CONFIG_DIR} and job history in ${XDG_STATE_HOME:-$HOME/.local/state}/claude-omp"
}

case "${1:-}" in
  ""|--plugin) check_deps; install_plugin; install_cli; seed_config ;;
  --link)      check_deps; install_link; install_cli; seed_config ;;
  --cli)       check_deps; install_cli; seed_config ;;
  --uninstall) uninstall ;;
  -h|--help)   sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
esac
