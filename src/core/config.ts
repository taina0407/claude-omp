/**
 * User config (`~/.config/claude-omp/config.json`): a `defaults` block applied to every run and
 * named `presets`. Same file format as v0.2.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { configFile } from "./paths";
import { UsageError } from "./util";

const duration = z.union([z.string(), z.number()]);

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
