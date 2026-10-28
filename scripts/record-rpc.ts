#!/usr/bin/env bun
/**
 * Records real omp RPC transcripts into tests/fixtures/rpc/.
 *
 *   bun run record                       # every scenario, in order
 *   bun run record v2-abort v2-restore   # selected scenarios
 *
 * Env: SPIKE_DIR (scratch workspace, default $TMPDIR/claude-omp-spike), SPIKE_MODEL (default
 * smol), OMP_BIN (default omp). Scenarios call a real model and cost a little.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import {
	anonymize,
	compactForFixture,
	type RecordResult,
	record,
	truncateStrings,
} from "./rpc-recorder";
import { scenarios } from "./rpc-scenarios";

const root = resolve(import.meta.dir, "..");
const outDir = join(root, "tests/fixtures/rpc");
const spikeDir = resolve(process.env.SPIKE_DIR ?? join(tmpdir(), "claude-omp-spike"));
const workdir = join(spikeDir, "work");
const sessionDir = join(spikeDir, "sessions");
const varsFile = join(spikeDir, "vars.json");
const ompBin = process.env.OMP_BIN ?? "omp";
/** Long strings (model text, base64 chunks, bash output) are cut to keep fixtures reviewable. */
const MAX_STRING = 2000;

async function sh(cmd: string[], cwd: string) {
	const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	if ((await p.exited) !== 0)
		throw new Error(`${cmd.join(" ")}: ${await new Response(p.stderr).text()}`);
	return (await new Response(p.stdout).text()).trim();
}

async function resetWorkdir() {
	rmSync(workdir, { recursive: true, force: true });
	mkdirSync(workdir, { recursive: true });
	writeFileSync(join(workdir, "a.txt"), "alpha\nbeta\n");
	writeFileSync(join(workdir, "b.txt"), "bravo is the second file\n");
	writeFileSync(join(workdir, "README.md"), "# spike\nA tiny repo for omp RPC recordings.\n");
	await sh(["git", "init", "-q", "-b", "main"], workdir);
	await sh(["git", "add", "."], workdir);
	await sh(
		[
			"git",
			"-c",
			"user.name=spike",
			"-c",
			"user.email=spike@example.invalid",
			"commit",
			"-qm",
			"init",
		],
		workdir,
	);
}

async function loadVars(): Promise<Record<string, string>> {
	const f = Bun.file(varsFile);
	return (await f.exists()) ? ((await f.json()) as Record<string, string>) : {};
}

function writeFixture(name: string, description: string, result: RecordResult, ompVersion: string) {
	const replacements: Array<[string, string]> = [
		[workdir, "<WORKDIR>"],
		[sessionDir, "<SESSIONS>"],
		[spikeDir, "<SPIKE>"],
		[homedir(), "<HOME>"],
		[userInfo().username, "<USER>"],
	];
	const clean = (v: unknown) => truncateStrings(anonymize(v, replacements), MAX_STRING);
	const header = {
		fixture: name,
		description,
		ompVersion,
		recordedAt: new Date().toISOString(),
		argv: clean(result.argv.slice(1)),
		exitCode: result.exitCode,
		error: result.error ?? null,
		notes: result.notes,
		frameCount: result.lines.length,
	};
	const body = result.lines.map((l) =>
		JSON.stringify(clean({ ...l, frame: compactForFixture(l.frame) })),
	);
	writeFileSync(join(outDir, `${name}.jsonl`), `${[JSON.stringify(header), ...body].join("\n")}\n`);
	const stderr = clean(result.stderr.trim()) as string;
	if (stderr) writeFileSync(join(outDir, `${name}.stderr.txt`), `${stderr}\n`);
	else rmSync(join(outDir, `${name}.stderr.txt`), { force: true });
}

async function main() {
	const wanted = process.argv.slice(2);
	const selected = wanted.length ? scenarios.filter((s) => wanted.includes(s.name)) : scenarios;
	const unknown = wanted.filter((w) => !scenarios.some((s) => s.name === w));
	if (unknown.length) throw new Error(`unknown scenario(s): ${unknown.join(", ")}`);

	mkdirSync(outDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	const ompVersion = await sh([ompBin, "--version"], root);
	const vars = await loadVars();
	let failed = 0;

	for (const scenario of selected) {
		await resetWorkdir();
		process.stdout.write(`▶ ${scenario.name} … `);
		const result = await record(scenario, {
			ompBin,
			workdir,
			sessionDir,
			vars,
			timeoutMs: 240_000,
		});
		Object.assign(vars, result.exports);
		await Bun.write(varsFile, JSON.stringify(vars, null, 2));
		writeFixture(scenario.name, scenario.description, result, ompVersion);
		if (result.error) failed++;
		console.log(
			result.error
				? `FAILED: ${result.error}`
				: `ok (${result.lines.length} frames, exit ${result.exitCode})`,
		);
		for (const n of result.notes) console.log(`    note: ${n}`);
	}
	process.exit(failed ? 1 : 0);
}

await main();
