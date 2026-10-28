/**
 * Where omp-task keeps its state and config. The environment overrides are the same as v0.2:
 * OMP_TASK_HOME (state dir), OMP_TASK_CONFIG (config file), OMP_TASK_OMP_BIN (omp binary).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import PREAMBLE from "../prompts/worker-preamble.md" with { type: "text" };

function expand(p: string): string {
	return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function stateDir(): string {
	const override = process.env.OMP_TASK_HOME;
	if (override) return resolve(expand(override));
	const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(base, "claude-omp");
}

export function configFile(): string {
	const override = process.env.OMP_TASK_CONFIG;
	if (override) return resolve(expand(override));
	const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(base, "claude-omp", "config.json");
}

export function jobsDir(): string {
	const dir = join(stateDir(), "jobs");
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function jobDir(id: string): string {
	return join(jobsDir(), id);
}

export function dbFile(): string {
	mkdirSync(stateDir(), { recursive: true });
	return join(stateDir(), "state.db");
}

/** The omp binary as configured; null when it cannot be found. */
export function ompBin(): string | null {
	const candidate = process.env.OMP_TASK_OMP_BIN || "omp";
	if (isAbsolute(candidate) || candidate.includes("/")) return resolve(candidate);
	return Bun.which(candidate);
}

/**
 * The worker preamble appended to omp's system prompt for new sessions. It is built into the
 * CLI (so a compiled binary has it too) and written to the state dir for omp to read.
 */
export function preambleFile(): string {
	const dir = join(stateDir(), "prompts");
	const file = join(dir, "worker-preamble.md");
	if (!existsSync(file) || readFileSync(file, "utf8") !== PREAMBLE) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, PREAMBLE);
	}
	return file;
}

/** True inside a `bun build --compile` binary, whose sources live in Bun's virtual filesystem. */
export const COMPILED =
	import.meta.path.startsWith("/$bunfs/") || import.meta.path.includes("~BUN");

/** The CLI entry point, used to spawn the daemon (a compiled binary is its own entry point). */
export const CLI_ENTRY = join(import.meta.dir, "..", "cli", "main.ts");

/** How to run this CLI again: `[...cliCommand(), "daemon"]`. */
export function cliCommand(): string[] {
	return COMPILED ? [process.execPath] : [process.execPath, CLI_ENTRY];
}

/**
 * The daemon's socket. One daemon serves one state dir, so the name is derived from it; it lives
 * in the runtime dir (AF_UNIX paths are limited to ~108 bytes, which rules out the state dir).
 */
export function socketPath(): string {
	const base = process.env.XDG_RUNTIME_DIR
		? join(process.env.XDG_RUNTIME_DIR, "claude-omp")
		: join(tmpdir(), `claude-omp-${process.getuid?.() ?? "user"}`);
	mkdirSync(base, { recursive: true, mode: 0o700 });
	chmodSync(base, 0o700);
	const key = new Bun.CryptoHasher("sha256").update(stateDir()).digest("hex").slice(0, 12);
	return join(base, `${key}.sock`);
}

export function lockFile(): string {
	mkdirSync(stateDir(), { recursive: true });
	return join(stateDir(), "daemon.lock");
}

export function daemonLogFile(): string {
	mkdirSync(stateDir(), { recursive: true });
	return join(stateDir(), "daemon.log");
}
