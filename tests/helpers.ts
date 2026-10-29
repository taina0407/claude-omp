/**
 * A throwaway world for end-to-end tests: a git repo, a fake omp on a private path, and a private
 * state dir (so each test gets its own daemon), torn down with the daemon after the test.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import type { Job } from "../src/core/types";

const ROOT = join(import.meta.dir, "..");
export const CLI = join(ROOT, "src/cli/main.ts");
/**
 * How the tests run omp-task: from source, or a compiled binary when OMP_TASK_TEST_BIN names one
 * (`OMP_TASK_TEST_BIN=dist/omp-task bun test` runs the whole suite against the binary).
 */
export const CLI_CMD = process.env.OMP_TASK_TEST_BIN
	? [process.env.OMP_TASK_TEST_BIN]
	: [process.execPath, CLI];
const FAKE = join(import.meta.dir, "fake-omp/fake-omp.ts");

export interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

export type JobJson = Record<string, unknown> & {
	id: string;
	status: string;
	result: string;
	errors: string[];
};

export class Sandbox {
	readonly base: string;
	readonly repo: string;
	readonly env: Record<string, string>;
	readonly cmd: string[];

	/** `cmd` runs omp-task (default: CLI_CMD, i.e. the sources or OMP_TASK_TEST_BIN). */
	constructor(cmd: string[] = CLI_CMD) {
		this.cmd = cmd;
		this.base = mkdtempSync(join(tmpdir(), "omp-v1-"));
		this.repo = join(this.base, "repo");
		mkdirSync(this.repo);
		Bun.spawnSync(["git", "init", "-q"], { cwd: this.repo });
		writeFileSync(join(this.repo, "existing.txt"), "hi\n");
		const bin = join(this.base, "bin");
		mkdirSync(bin);
		const fake = join(bin, "omp");
		writeFileSync(fake, `#!/bin/sh\nexec ${process.execPath} ${FAKE} "$@"\n`);
		chmodSync(fake, 0o755);
		this.env = {
			...(process.env as Record<string, string>),
			OMP_TASK_HOME: join(this.base, "state"),
			OMP_TASK_CONFIG: join(this.base, "config.json"),
			OMP_TASK_OMP_BIN: fake,
			FAKE_OMP_LOG: join(this.base, "argv.log"),
			FAKE_OMP_SESSIONS: join(this.base, "sessions.txt"),
			XDG_RUNTIME_DIR: join(this.base, "run"),
		};
	}

	async dispose(): Promise<void> {
		await this.cli(["daemon", "stop", "--force"], null);
		rmSync(this.base, { recursive: true, force: true });
	}

	get stateDir(): string {
		return this.env.OMP_TASK_HOME as string;
	}

	writeConfig(config: unknown): void {
		writeFileSync(this.env.OMP_TASK_CONFIG as string, JSON.stringify(config));
	}

	/** Runs git in the sandbox repo and returns its stdout. */
	git(...args: string[]): string {
		const p = Bun.spawnSync(["git", ...args], {
			cwd: this.repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (p.exitCode !== 0) {
			throw new Error(`git ${args.join(" ")} → ${p.stderr.toString()}`);
		}
		return p.stdout.toString();
	}

	/** Commits everything in the sandbox repo (worktrees need at least one commit). */
	commitAll(message = "init"): void {
		this.git("add", "-A");
		this.git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", message);
	}

	async cli(
		args: string[],
		ok: number[] | null = [0],
		env: Record<string, string> = {},
	): Promise<Result> {
		const p = Bun.spawn([...this.cmd, ...args], {
			cwd: this.repo,
			env: { ...this.env, ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		if (ok && !ok.includes(code)) {
			throw new Error(`${args.join(" ")} → exit ${code}\nstdout: ${stdout}\nstderr: ${stderr}`);
		}
		return { code, stdout, stderr };
	}

	/** Runs `omp-task hook <name>` with the hook's JSON on stdin, as Claude Code does. */
	async hook(name: string, input: unknown, env: Record<string, string> = {}): Promise<Result> {
		const p = Bun.spawn([...this.cmd, "hook", name], {
			cwd: this.repo,
			env: { ...this.env, ...env },
			stdin: new Blob([JSON.stringify(input)]),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		return { code, stdout, stderr };
	}

	async runJson(args: string[], ok = [0]): Promise<JobJson> {
		return JSON.parse((await this.cli(["run", "--json", ...args], ok)).stdout) as JobJson;
	}

	async start(args: string[], env: Record<string, string> = {}): Promise<string> {
		const { stdout } = await this.cli(["run", "--detach", "--json", ...args], [0], env);
		return (JSON.parse(stdout) as { id: string }).id;
	}

	async waitJson(job: string, extra: string[] = [], ok = [0, 1]): Promise<JobJson> {
		const { stdout } = await this.cli(["wait", job, "--max-wait", "60", "--json", ...extra], ok);
		return JSON.parse(stdout.split("\n\n")[0] as string) as JobJson;
	}

	ompArgvs(): string[][] {
		return readFileSync(this.env.FAKE_OMP_LOG as string, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as string[]);
	}

	ompArgv(): string[] {
		return this.ompArgvs().at(-1) as string[];
	}

	/** Reads the job straight from the database (read-only use next to the daemon). */
	job(id: string): Job | null {
		const store = new Store(join(this.stateDir, "state.db"));
		try {
			return store.getJob(id);
		} finally {
			store.close();
		}
	}

	jobStatus(id: string): string | undefined {
		return this.job(id)?.status;
	}

	async waitForStatus(job: string, status: string, timeoutMs = 20_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.jobStatus(job) === status) return;
			await Bun.sleep(50);
		}
		throw new Error(`job ${job} never reached ${status} (is ${this.jobStatus(job)})`);
	}

	daemonLog(): string {
		try {
			return readFileSync(join(this.stateDir, "daemon.log"), "utf8");
		} catch {
			return "";
		}
	}
}

export function argAfter(argv: string[], flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
}
