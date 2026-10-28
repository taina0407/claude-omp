#!/usr/bin/env bun
/**
 * M0 probe: which omp session flags work together with `--mode rpc`? Each case starts omp,
 * waits up to 20s for the RPC `ready` frame or for the process to exit, and records the outcome.
 * No prompt is sent, so no model is called.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const omp = process.env.OMP_BIN ?? "omp";
const cwd = mkdtempSync(join(tmpdir(), "omp-flags-"));
const cases: Array<{ name: string; args: string[] }> = [
	{ name: "baseline", args: [] },
	{ name: "restore", args: ["--restore", "does-not-matter"] },
	{ name: "from-claude", args: ["--from-claude"] },
	{ name: "resume-unknown-id", args: ["--resume", "00000000"] },
	{ name: "max-time", args: ["--max-time", "5m"] },
];

const results: Array<Record<string, unknown>> = [];
for (const c of cases) {
	const proc = Bun.spawn([omp, "--mode", "rpc", "--no-ui", "--cwd", cwd, ...c.args], {
		cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const firstLine = (async () => {
		const reader = proc.stdout.getReader();
		const { value } = await reader.read();
		reader.releaseLock();
		return new TextDecoder().decode(value ?? new Uint8Array()).split("\n")[0] ?? "";
	})();
	const outcome = await Promise.race([
		firstLine.then((line) => ({ kind: line.includes('"ready"') ? "ready" : "output", line })),
		proc.exited.then((code) => ({ kind: "exited", code })),
		Bun.sleep(20_000).then(() => ({ kind: "timeout" })),
	]);
	proc.stdin.end();
	await Promise.race([proc.exited, Bun.sleep(5_000)]);
	if (proc.exitCode === null) proc.kill("SIGKILL");
	const stderr = Bun.stripANSI(await new Response(proc.stderr).text())
		.trim()
		.split("\n")
		.slice(0, 3)
		.join(" | ");
	results.push({ case: c.name, args: c.args, ...outcome, exitCode: proc.exitCode, stderr });
}
rmSync(cwd, { recursive: true, force: true });
console.log(JSON.stringify(results, null, 2));
