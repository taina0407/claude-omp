/** The daemon's log: JSON lines, rotated to `daemon.log.1` once it passes MAX_BYTES. */
import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { daemonLogFile } from "../core/paths";

const MAX_BYTES = 5 * 1024 * 1024;

export type Level = "debug" | "info" | "warn" | "error";

export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
	const file = daemonLogFile();
	try {
		if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
		appendFileSync(
			file,
			`${JSON.stringify({ ts: new Date().toISOString(), level, pid: process.pid, message, ...fields })}\n`,
		);
	} catch {
		// Logging must never take the daemon down.
	}
}
