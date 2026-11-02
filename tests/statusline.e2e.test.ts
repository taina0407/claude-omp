/** `omp-task statusline` (Claude Code's subagentStatusLine) and the shim that reaches it. */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Result, Sandbox } from "./helpers";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
let sb: Sandbox;

beforeEach(() => {
	sb = new Sandbox();
});

afterEach(async () => {
	await sb.dispose();
});

const daemonRunning = () => existsSync(join(sb.stateDir, "daemon.lock"));

/** What Claude Code sends: the session, the row width and the agent panel's rows. */
function input(tasks: Record<string, unknown>[], session = "s1") {
	return { session_id: session, columns: 200, tasks };
}

const omp = (id: string, description: string, agentType = "omp:job") => ({
	id,
	type: "local_agent",
	agentType,
	status: "running",
	description,
	label: description,
	model: "claude-haiku-5-5",
	tokenCount: 3000,
});

function lines(r: Result): { id: string; content: string }[] {
	expect(r.code).toBe(0);
	return r.stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { id: string; content: string });
}

describe("statusline", () => {
	test("without a daemon it prints nothing and starts none", async () => {
		const r = await sb.pipe(["statusline"], input([omp("a1", "omp ab12: fix tests [smol]")]));
		expect(lines(r)).toEqual([]);
		expect(daemonRunning()).toBe(false);
	});

	test("decorates omp relays only, with what the job waits on", async () => {
		const job = await sb.start(["--title", "fix tests", "BASH"]);
		await sb.waitForStatus(job, "waiting");
		const short = job.slice(-4);
		const r = await sb.pipe(
			["statusline"],
			input([
				omp("a1", `omp ${short}: fix tests [smol]`),
				omp("a2", "Explore the auth module", "Explore"),
				omp("a3", `omp ${short}: not ours`, "general-purpose"),
				omp("a4", "omp ffff: a job that does not exist"),
				omp("a5", "something else entirely"),
			]),
		);
		const out = lines(r);
		expect(out.map((l) => l.id)).toEqual(["a1"]);
		expect(out[0]?.content).toMatch(
			new RegExp(
				`^omp ${short}: fix tests · waiting \\d+s · fake-1 · \\$0\\.\\d{4} · needs: approval bash: make test$`,
			),
		);

		const status = JSON.parse((await sb.cli(["status", job, "--json"])).stdout);
		await sb.cli(["hold", job, "--ref", status.pending[0].id]);
		const held = lines(await sb.pipe(["statusline"], input([omp("a1", `omp ${short}: x`)])));
		expect(held[0]?.content).toContain("· held for user: approval bash: make test");
		await sb.cli(["cancel", job]);
	});

	test("a group row sums up this session's jobs in the group", async () => {
		const env = { OMP_TASK_CLAUDE_SESSION: "s1" };
		const a = JSON.parse(
			(await sb.cli(["run", "-d", "--json", "-g", "fan-1", "BASH"], [0], env)).stdout,
		).id as string;
		const b = JSON.parse(
			(await sb.cli(["run", "-d", "--json", "-g", "fan-1", "-a", "read", "SLEEP"], [0], env))
				.stdout,
		).id as string;
		await sb.waitForStatus(a, "waiting");
		await sb.waitForStatus(b, "running");
		const out = lines(
			await sb.pipe(["statusline"], input([omp("g1", "omp group fan-1: two jobs [smol]")])),
		);
		expect(out[0]?.content).toBe(
			`omp group fan-1: two jobs · 1 waiting, 1 running · $0.0000 · ${a.slice(-4)} needs: approval bash: make test`,
		);
		await sb.cli(["cancel", a]);
		await sb.cli(["cancel", b]);
	});

	test("a broken input still exits 0 without output", async () => {
		const r = await sb.pipe(["statusline"], "not json at all");
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("");
	});
});

describe("the plugin's subagentStatusLine", () => {
	const settings = JSON.parse(readFileSync(join(ROOT, "settings.json"), "utf8"));
	const command = settings.subagentStatusLine.command as string;

	/** Runs the settings command the way Claude Code does: through a shell, rows on stdin. */
	async function run(stdin: unknown): Promise<Result> {
		const p = Bun.spawn(["sh", "-c", command], {
			cwd: sb.repo,
			env: sb.env,
			stdin: new Blob([JSON.stringify(stdin)]),
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

	test("exits 0 quietly until a session wrote the shim", async () => {
		const r = await run(input([omp("a1", "omp ab12: x")]));
		expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
	});

	test("session-start points the shim at the plugin; the command then reaches statusline", async () => {
		await sb.hook("session-start", { session_id: "s1" }, { CLAUDE_PLUGIN_ROOT: ROOT });
		const shim = join(sb.stateDir, "subagent-statusline");
		expect(statSync(shim).mode & 0o111).not.toBe(0);
		expect(readFileSync(shim, "utf8")).toContain(`exec '${ROOT}/bin/omp-task' statusline`);
		expect(daemonRunning()).toBe(false);

		const job = await sb.start(["--title", "fix tests", "BASH"]);
		await sb.waitForStatus(job, "waiting");
		const out = lines(await run(input([omp("a1", `omp ${job.slice(-4)}: fix tests [smol]`)])));
		expect(out[0]?.content).toContain("needs: approval bash: make test");
		await sb.cli(["cancel", job]);
	});
});
