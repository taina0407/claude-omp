/**
 * The environment of the daemon and its workers. The daemon is started by whichever Claude Code
 * session first runs `omp-task`, and every worker is its child, so without this they would all
 * carry that session's identity: its id, its messaging socket, and the terminal pane its status
 * hooks report to (Orca, tmux, terminal tabs). Another session's worker would then show up as,
 * or talk to, the first session.
 */

/** Variables that tie a process to one Claude Code session or one terminal pane. */
const SESSION_VARS =
	/^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_ENV_FILE|CLAUDE_PROJECT_DIR|OMP_TASK_CLAUDE_SESSION|ORCA_.*|TMUX_PANE|TERM_SESSION_ID|ITERM_SESSION_ID|KITTY_WINDOW_ID|WEZTERM_PANE|ZELLIJ_PANE_ID|WINDOWID)$/;

/** `env` without the variables of the session or pane it was inherited from. */
export function detachedEnv(env: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) {
		if (v !== undefined && !SESSION_VARS.test(k)) out[k] = v;
	}
	return out;
}

/** A worker's environment: detached, plus the Claude session of its own job. */
export function workerEnv(
	env: Record<string, string | undefined>,
	claudeSession: string | null,
): Record<string, string> {
	const out = detachedEnv(env);
	if (claudeSession) out.OMP_TASK_CLAUDE_SESSION = claudeSession;
	return out;
}
