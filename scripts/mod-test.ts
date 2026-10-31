/**
 * Runs the mod's tests (hooks/*.test.tsx) with `claude plugin test`. That runner loads every
 * *.test.ts under the folder it is given, and the repository's own tests are `bun test` files, so
 * the mod's files (manifest, hooks, contract) are copied to a folder of their own first.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "omp-mod-test-"));
try {
	for (const part of [".claude-plugin/plugin.json", "hooks", "types"]) {
		cpSync(join(root, part), join(dir, part), { recursive: true });
	}
	const p = Bun.spawn(["claude", "plugin", "test", dir], { stdout: "inherit", stderr: "inherit" });
	process.exitCode = await p.exited;
} finally {
	rmSync(dir, { recursive: true, force: true });
}
