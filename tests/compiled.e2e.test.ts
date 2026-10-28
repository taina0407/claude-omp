/**
 * The release binary (`bun build --compile`) must work without the sources: embedded prompts
 * and example config, and a daemon started from the binary itself.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argAfter, Sandbox } from "./helpers";

setDefaultTimeout(120_000);

const ROOT = join(import.meta.dir, "..");
const outDir = mkdtempSync(join(tmpdir(), "omp-bin-"));
const bin = join(outDir, "omp-task");
let sb: Sandbox;

beforeAll(() => {
	const p = Bun.spawnSync(
		["bun", "build", "--compile", join(ROOT, "src/cli/main.ts"), "--outfile", bin],
		{ cwd: ROOT, stdout: "pipe", stderr: "pipe" },
	);
	if (p.exitCode !== 0) throw new Error(p.stderr.toString());
	sb = new Sandbox([bin]);
	sb.commitAll();
});

afterAll(async () => {
	await sb.dispose();
	rmSync(outDir, { recursive: true, force: true });
});

test("the binary runs jobs, reviews and setup on its own", async () => {
	const { stdout } = await sb.cli(["doctor"], [0, 1]);
	expect(stdout).toContain("compiled");
	const job = await sb.runJson(["WRITE a.txt"]);
	expect(job.status).toBe("completed");
	const preamble = argAfter(sb.ompArgv(), "--append-system-prompt") as string;
	expect(readFileSync(preamble, "utf8")).toContain("report");
	expect(sb.daemonLog()).toContain('"listening"');

	writeFileSync(join(sb.repo, "existing.txt"), "bye\n");
	const review = JSON.parse((await sb.cli(["review", "--json", "--focus", "REVIEW"])).stdout);
	expect(review.review.verdict).toBe("request_changes");
	expect(readFileSync(join(review.job_dir, "prompt.md"), "utf8")).toContain("Change under review");

	await sb.cli(["setup"]);
	const config = JSON.parse(readFileSync(sb.env.OMP_TASK_CONFIG as string, "utf8"));
	expect(config.presets.cheap.model).toBe("smol");
});

test("the plugin launcher installs a release binary after checking its sha256, then prefers it", () => {
	// A plugin root with only the launcher and package.json: running anything proves the binary ran.
	const root = join(outDir, "plugin");
	mkdirSync(join(root, "bin"), { recursive: true });
	copyFileSync(join(ROOT, "bin/omp-task"), join(root, "bin/omp-task"));
	copyFileSync(join(ROOT, "package.json"), join(root, "package.json"));
	const release = join(outDir, "release");
	mkdirSync(release, { recursive: true });
	const os = process.platform;
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	const name = `omp-task-${os}-${arch}`;
	copyFileSync(bin, join(release, name));
	const hash = new Bun.CryptoHasher("sha256").update(readFileSync(bin)).digest("hex");
	const run = (args: string[], sums: string) => {
		writeFileSync(join(release, "SHA256SUMS"), sums);
		return Bun.spawnSync([join(root, "bin/omp-task"), ...args], {
			env: { ...sb.env, OMP_TASK_RELEASE_URL: `file://${release}`, PATH: "/usr/bin:/bin" },
			stdout: "pipe",
			stderr: "pipe",
		});
	};
	const bad = run(["install-binary"], `${"0".repeat(64)}  ${name}\n`);
	expect(bad.exitCode).not.toBe(0);
	expect(bad.stderr.toString()).toContain("checksum mismatch");
	const good = run(["install-binary"], `${hash}  ${name}\n`);
	expect(good.stdout.toString()).toContain("installed");
	// PATH has no bun and the root has no sources: only the binary can answer.
	const version = run(["--version"], "");
	expect(version.stdout.toString()).toMatch(/^omp-task \d/);
});
