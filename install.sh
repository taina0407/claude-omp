#!/usr/bin/env bash
# Install the omp plugin for Claude Code at user level.
#
#   ./install.sh            plugin install from this checkout (marketplace "omp-tools") + omp-task CLI
#   ./install.sh --cli      only put omp-task on PATH (~/.local/bin) and install dependencies
#   ./install.sh --uninstall
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN=omp
MARKETPLACE=omp-tools
BIN_DIR="${OMP_TASK_BIN_DIR:-$HOME/.local/bin}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/claude-omp"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }

check_deps() {
  command -v bun >/dev/null || [[ -x "$HOME/.bun/bin/bun" ]] || {
    echo "Bun is required: curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
  }
  command -v omp >/dev/null || warn "omp not found on PATH — install it before delegating (https://github.com/can1357/oh-my-pi)"
}

install_cli() {
  (cd "$REPO" && "$(command -v bun || echo "$HOME/.bun/bin/bun")" install --production --frozen-lockfile --silent)
  mkdir -p "$BIN_DIR"
  ln -sfn "$REPO/bin/omp-task" "$BIN_DIR/omp-task"
  say "linked $BIN_DIR/omp-task"
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "$BIN_DIR is not on PATH" ;; esac
}

seed_config() {
  "$REPO/bin/omp-task" setup >/dev/null && say "config: $CONFIG_DIR/config.json"
}

install_plugin() {
  command -v claude >/dev/null || { echo "claude CLI not found" >&2; exit 1; }
  claude plugin marketplace add "$REPO" --scope user || claude plugin marketplace update "$MARKETPLACE"
  claude plugin install "$PLUGIN@$MARKETPLACE" --scope user || claude plugin update "$PLUGIN@$MARKETPLACE"
  say "installed $PLUGIN@$MARKETPLACE — run /reload-plugins in open sessions"
}

uninstall() {
  [[ -L "$BIN_DIR/omp-task" ]] && rm "$BIN_DIR/omp-task" && say "removed $BIN_DIR/omp-task"
  if command -v claude >/dev/null; then
    claude plugin uninstall "$PLUGIN@$MARKETPLACE" --scope user || true
  fi
  "$REPO/bin/omp-task" daemon stop --force >/dev/null 2>&1 || true
  say "kept $CONFIG_DIR and ~/.local/state/claude-omp (delete them by hand if you want)"
}

case "${1:-}" in
  "") check_deps; install_cli; seed_config; install_plugin ;;
  --cli) check_deps; install_cli; seed_config ;;
  --uninstall) uninstall ;;
  *) echo "usage: $0 [--cli | --uninstall]" >&2; exit 2 ;;
esac
