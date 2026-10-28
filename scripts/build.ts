#!/usr/bin/env bun
/**
 * Release build: one self-contained omp-task binary per platform, plus SHA256SUMS.
 *
 *   bun run build              all targets into dist/
 *   bun run build linux-x64    only the named targets
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

const wanted = process.argv.slice(2);
const targets = wanted.length ? TARGETS.filter((t) => wanted.includes(t)) : TARGETS;
if (!targets.length) throw new Error(`unknown target; pick from ${TARGETS.join(", ")}`);
mkdirSync(DIST, { recursive: true });

const sums: string[] = [];
for (const target of targets) {
	const name = `omp-task-${target}`;
	const outfile = join(DIST, name);
	const p = Bun.spawnSync(
		[
			process.execPath,
			"build",
			"--compile",
			"--minify",
			`--target=bun-${target}`,
			join(ROOT, "src/cli/main.ts"),
			"--outfile",
			outfile,
		],
		{ cwd: ROOT, stdout: "inherit", stderr: "inherit" },
	);
	if (p.exitCode !== 0) throw new Error(`build failed for ${target}`);
	const hash = new Bun.CryptoHasher("sha256").update(readFileSync(outfile)).digest("hex");
	sums.push(`${hash}  ${name}`);
	console.log(`${name}  ${hash}`);
}
writeFileSync(join(DIST, "SHA256SUMS"), `${sums.join("\n")}\n`);
