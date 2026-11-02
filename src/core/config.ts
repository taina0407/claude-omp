/**
 * User config (`~/.config/claude-omp/config.json`): a `defaults` block applied to every run and
 * named `presets`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { configFile } from "./paths";
import { UsageError } from "./util";

const duration = z.union([z.string(), z.number()]);

export const SUPERVISE_MODES = ["subagent", "bash"] as const;
export type SuperviseMode = (typeof SUPERVISE_MODES)[number];
export const DEFAULT_SUPERVISE: SuperviseMode = "subagent";

const settings = z.looseObject({
	model: z.string().optional(),
	access: z.enum(["read", "edit", "full"]).optional(),
	thinking: z.string().optional(),
	timeout: duration.optional(),
	answer_timeout: duration.optional(),
	approval_timeout: duration.optional(),
	omp_args: z.string().optional(),
	/** auto (default) | worktree | none; see `omp-task run --isolate`. */
	isolate: z.enum(["auto", "worktree", "none"]).optional(),
	/** Approval globs decided without asking (see core/policy.ts); merged with --allow/--deny. */
	allow: z.array(z.string()).optional(),
	deny: z.array(z.string()).optional(),
	/** No worker activity for this long wakes the orchestrator (default 10m; 0 disables). */
	stall_timeout: duration.optional(),
	/** Per-job spending limit in USD. */
	budget: z.number().positive().optional(),
});

export type Settings = z.infer<typeof settings>;

const groupLimits = z.looseObject({
	max_concurrent: z.number().int().positive().optional(),
	budget_usd: z.number().positive().optional(),
});

const configSchema = z.looseObject({
	defaults: settings.optional(),
	presets: z.record(z.string(), settings).optional(),
	/** Resume jobs the daemon was running when it stopped, as soon as it starts again. */
	auto_resume: z.boolean().optional(),
	/** Stop the daemon after this long with no jobs and no clients (default 15m). */
	daemon_idle_timeout: duration.optional(),
	/**
	 * What a job's events.jsonl keeps: compact (default) drops the full message every streamed
	 * update repeats, full keeps every frame as omp sent it, off writes nothing.
	 */
	event_log: z.enum(["compact", "full", "off"]).optional(),
	/** Finished jobs (and their files) are deleted after this long (default 30d; 0 keeps them). */
	job_retention: duration.optional(),
	/** Jobs running at once across every session (no limit unless set). */
	max_concurrent: z.number().int().positive().optional(),
	/**
	 * Jobs one Claude Code session runs at once (default 4); jobs started outside Claude Code
	 * share one allowance.
	 */
	max_concurrent_per_session: z.number().int().positive().optional(),
	/** Jobs that may edit one checkout at once when they are not isolated (default 1). */
	max_writers_per_repo: z.number().int().positive().optional(),
	/** Spending limit for all jobs created on one (local) day. */
	daily_budget_usd: z.number().positive().optional(),
	/** Default limits per group name; `plan apply` can set them too. */
	groups: z.record(z.string(), groupLimits).optional(),
	/**
	 * How Claude waits on jobs: `subagent` (default) starts the plugin's `omp:job` agent in the
	 * background, one row per job in the host's agent panel; `bash` runs `omp-task wait` as a
	 * background Bash command, as before 1.6. `run --detach` tells Claude which (its `next:` line).
	 */
	supervise: z.enum(SUPERVISE_MODES).optional(),
	/** When a Claude Code session ends: keep its running jobs (default) or cancel them. */
	on_session_end: z.enum(["keep", "cancel"]).optional(),
	/** Opt-in Stop hook: review uncommitted changes before Claude finishes a turn. */
	stop_gate: z
		.looseObject({
			enabled: z.boolean().optional(),
			/** Reviewer model (default smol). */
			model: z.string().optional(),
			/** Review time limit (default 3m). */
			timeout: duration.optional(),
			/** Lowest severity that blocks (default high). */
			min_severity: z.enum(["critical", "high", "medium", "low"]).optional(),
			/** Reviews per Claude session at most (default 3). */
			max_per_session: z.number().int().positive().optional(),
			/** Passed to the reviewer as --focus. */
			focus: z.string().optional(),
		})
		.optional(),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(path = configFile()): Config {
	if (!existsSync(path)) return {};
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		throw new UsageError(`invalid JSON in ${path}: ${(e as Error).message}`);
	}
	const parsed = configSchema.safeParse(raw);
	if (!parsed.success) {
		throw new UsageError(`invalid config in ${path}: ${z.prettifyError(parsed.error)}`);
	}
	return parsed.data;
}

/**
 * Sets `supervise` in the config file (creating a minimal one), keeping everything else as it is.
 * A wrong `supervise` value is replaced; any other problem in the file is refused, unchanged.
 */
export function writeSupervise(mode: SuperviseMode, path = configFile()): void {
	let raw: unknown = {};
	if (existsSync(path)) {
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch (e) {
			throw new UsageError(`invalid JSON in ${path}: ${(e as Error).message}`);
		}
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new UsageError(`invalid config in ${path}: not a JSON object`);
	}
	const next = { ...(raw as Record<string, unknown>), supervise: mode };
	const parsed = configSchema.safeParse(next);
	if (!parsed.success) {
		throw new UsageError(`invalid config in ${path}: ${z.prettifyError(parsed.error)}`);
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
}

/** The configured supervise mode; the default when unset or the config does not load. */
export function superviseMode(path = configFile()): SuperviseMode {
	try {
		return loadConfig(path).supervise ?? DEFAULT_SUPERVISE;
	} catch {
		return DEFAULT_SUPERVISE;
	}
}

export function getPreset(config: Config, name: string): Settings {
	const preset = config.presets?.[name];
	if (!preset) throw new UsageError(`unknown preset '${name}' (define it in ${configFile()})`);
	return preset;
}

/**
 * Picks a setting by precedence: explicit flag, preset, parent job (for `continue`), config
 * defaults, built-in fallback.
 */
export function pickSetting<K extends keyof Settings>(
	key: K,
	sources: {
		flag: Settings[K] | undefined;
		preset: Settings;
		parent: Settings | undefined;
		defaults: Settings;
	},
	fallback?: Settings[K],
): Settings[K] | undefined {
	return (
		sources.flag ??
		sources.preset[key] ??
		sources.parent?.[key] ??
		sources.defaults[key] ??
		fallback
	);
}
