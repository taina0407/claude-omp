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
});

export type Settings = z.infer<typeof settings>;

const configSchema = z.looseObject({
	defaults: settings.optional(),
	presets: z.record(z.string(), settings).optional(),
	/** Resume jobs the daemon was running when it stopped, as soon as it starts again. */
	auto_resume: z.boolean().optional(),
	/** Stop the daemon after this long with no jobs and no clients (default 15m). */
	daemon_idle_timeout: duration.optional(),
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
