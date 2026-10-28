/**
 * One daemon per state dir. The lock file is created with O_EXCL and holds the owner's pid, so
 * when two CLIs start a daemon at the same moment exactly one of them wins; a lock whose pid is
 * gone is stale and is taken over.
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { lockFile } from "../core/paths";
import { pidAlive } from "../core/util";

export function lockOwner(path = lockFile()): number | null {
	try {
		const pid = Number(readFileSync(path, "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

/** Takes the lock for this process. Returns false when a live daemon already holds it. */
export function acquireLock(path = lockFile()): boolean {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx", 0o600);
			writeSync(fd, String(process.pid));
			closeSync(fd);
			return true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			const owner = lockOwner(path);
			if (owner === process.pid) return true;
			if (owner !== null && pidAlive(owner)) return false;
			// Stale (or still being written: an empty file). Give a writer a moment, then take over.
			if (owner === null) Bun.sleepSync(50);
			if (lockOwner(path) !== owner) continue;
			try {
				unlinkSync(path);
			} catch {
				// someone else removed it first; retry
			}
		}
	}
	return false;
}

export function releaseLock(path = lockFile()): void {
	if (lockOwner(path) !== process.pid) return;
	try {
		unlinkSync(path);
	} catch {
		// already gone
	}
}
