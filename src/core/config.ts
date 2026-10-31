/**
 * User config (`~/.config/claude-omp/config.json`): a `defaults` block applied to every run and
 * named `presets`.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { configFile } from "./paths";
import { parseDuration, UsageError } from "./util";

const duration = z.union([z.string(), z.number()]);

/** Who decides the workers' questions and approvals in a Claude session (`ui.decider`). */
export const DECIDERS = ["claude", "both", "user"] as const;
export type Decider = (typeof DECIDERS)[number];

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
	/** Jobs running at once across everything (default 4). */
	max_concurrent: z.number().int().positive().optional(),
	/** Jobs that may edit one checkout at once when they are not isolated (default 1). */
	max_writers_per_repo: z.number().int().positive().optional(),
	/** Spending limit for all jobs created on one (local) day. */
	daily_budget_usd: z.number().positive().optional(),
	/** Default limits per group name; `plan apply` can set them too. */
	groups: z.record(z.string(), groupLimits).optional(),
	/** When a Claude Code session ends: keep its running jobs (default) or cancel them. */
	on_session_end: z.enum(["keep", "cancel"]).optional(),
	/** The plugin's Claude Code UI (band, pane, dialogs). */
	ui: z
		.looseObject({
			/**
			 * Who answers the workers' questions and approvals: claude (default; it may hand one to
			 * the user), both (the UI asks the user and Claude is woken too), or user (the UI asks
			 * the user; Claude is woken only while no UI is connected).
			 */
			decider: z.enum(DECIDERS).optional(),
			/** Native notifications when a job needs the user or fails (default true). */
			notify: z.boolean().optional(),
			/** The band above the prompt: auto (while the session has jobs; default), always, off. */
			band: z.enum(["auto", "always", "off"]).optional(),
			/** How long finished jobs stay on the band and in the pane (default 10m). */
			recent: duration.optional(),
		})
		.optional(),
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

/** The `ui` block with its defaults filled in. */
export interface UiSettings {
	decider: Decider;
	notify: boolean;
	band: "auto" | "always" | "off";
	/** Seconds finished jobs stay on the UI. */
	recentS: number;
}

export const DEFAULT_UI_RECENT_S = 600;

export function uiSettings(config: Config): UiSettings {
	const ui = config.ui ?? {};
	return {
		decider: ui.decider ?? "claude",
		notify: ui.notify ?? true,
		band: ui.band ?? "auto",
		recentS: recentSeconds(ui.recent),
	};
}

function recentSeconds(value: string | number | undefined): number {
	if (value === undefined) return DEFAULT_UI_RECENT_S;
	try {
		return parseDuration(value) ?? 0;
	} catch {
		return DEFAULT_UI_RECENT_S;
	}
}
