/**
 * Scheduling: concurrency limits, dependencies (`--after`), skipped jobs, groups, budgets and
 * `plan apply`.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type JobJson, Sandbox } from "./helpers";

setDefaultTimeout(60_000);

let sb: Sandbox;

beforeEach(() => {
	sb = new Sandbox();
});

afterEach(async () => {
	await sb.dispose();
});

async function groupJobs(group: string): Promise<Record<string, unknown>[]> {
	const { stdout } = await sb.cli(["summary", group, "--json"]);
	return (JSON.parse(stdout) as { jobs: Record<string, unknown>[] }).jobs;
}

describe("concurrency", () => {
	test("max_concurrent queues jobs until a slot frees", async () => {
		sb.writeConfig({ max_concurrent: 1 });
		const a = await sb.start(["--access", "read", "SLEEP"]);
		await sb.waitForStatus(a, "running");
		const b = await sb.start(["--access", "read", "hello"]);
		await Bun.sleep(300);
		expect(sb.jobStatus(b)).toBe("queued");
		await sb.cli(["steer", a, "done"]);
		expect((await sb.waitJson(b)).status).toBe("completed");
		expect((sb.job(b)?.startedAt as string) >= (sb.job(a)?.finishedAt as string)).toBe(true);
	});

	test("two writers of one checkout take turns; a reader does not wait", async () => {
		const a = await sb.start(["SLEEP"]);
		await sb.waitForStatus(a, "running");
		const b = await sb.start(["WRITE b.txt"]);
		const reader = await sb.start(["--access", "read", "SLEEP"]);
		await sb.waitForStatus(reader, "running");
		expect(sb.jobStatus(b)).toBe("queued");
		await sb.cli(["steer", a, "done"]);
		expect((await sb.waitJson(b)).status).toBe("completed");
		await sb.cli(["cancel", reader]);
	});

	test("a queued job says what holds it back, naming another session's writer", async () => {
		const a = await sb.start(["SLEEP"], { OMP_TASK_CLAUDE_SESSION: "session-a" });
		await sb.waitForStatus(a, "running");
		const b = JSON.parse(
			(
				await sb.cli(["run", "--detach", "--json", "WRITE b.txt"], [0], {
					OMP_TASK_CLAUDE_SESSION: "session-b",
				})
			).stdout,
		) as { id: string; status: string; queue_reason?: string };
		expect(b.status).toBe("queued");
		expect(b.queue_reason).toContain(`${a} (another Claude session)`);
		const status = await sb.cli(["status", b.id]);
		expect(status.stdout).toContain("queued: ");
		await sb.cli(["steer", a, "done"]);
		expect((await sb.waitJson(b.id)).status).toBe("completed");
	});

	test("an interrupted writer keeps its turn across a daemon restart until it is resumed", async () => {
		const a = await sb.start(["SLEEP"]);
		await sb.waitForStatus(a, "running");
		const b = await sb.start(["WRITE b.txt"]);
		await sb.cli(["daemon", "stop", "--force"]);
		expect(sb.jobStatus(a)).toBe("interrupted");
		await sb.cli(["list"]); // starts a fresh daemon, which must not hand a's turn to b
		await Bun.sleep(300);
		expect(sb.jobStatus(b)).toBe("queued");
		await sb.cli(["resume", a, "--detach"]);
		expect((await sb.waitJson(b)).status).toBe("completed");
		expect((sb.job(b)?.startedAt as string) >= (sb.job(a)?.finishedAt as string)).toBe(true);
	});

	test("cancelling an interrupted writer frees its turn", async () => {
		const a = await sb.start(["SLEEP"]);
		await sb.waitForStatus(a, "running");
		const b = await sb.start(["WRITE b.txt"]);
		await sb.cli(["daemon", "stop", "--force"]);
		await sb.cli(["cancel", a]);
		expect((await sb.waitJson(b)).status).toBe("completed");
	});

	test("a group's max_concurrent from the config applies", async () => {
		sb.writeConfig({ groups: { g: { max_concurrent: 1 } } });
		const a = await sb.start(["--access", "read", "-g", "g", "SLEEP"]);
		await sb.waitForStatus(a, "running");
		const b = await sb.start(["--access", "read", "-g", "g", "hello"]);
		const other = await sb.start(["--access", "read", "hello"]);
		expect((await sb.waitJson(other)).status).toBe("completed");
		expect(sb.jobStatus(b)).toBe("queued");
		await sb.cli(["steer", a, "done"]);
		expect((await sb.waitJson(b)).status).toBe("completed");
	});
});

describe("dependencies", () => {
	test("a diamond runs in dependency order and wait --group returns once", async () => {
		const g = ["-g", "dia", "--access", "read"];
		const a = await sb.start([...g, "A"]);
		const b = await sb.start([...g, "--after", a, "B"]);
		const c = await sb.start([...g, "--after", a, "C"]);
		const d = await sb.start([...g, "--after", `${b},${c}`, "D"]);
		const r = await sb.cli(["wait", "--group", "dia"]);
		expect(r.stdout).toContain("WAKE: done (4 completed)");
		const job = (id: string) => sb.job(id) as NonNullable<ReturnType<Sandbox["job"]>>;
		for (const [before, after] of [
			[a, b],
			[a, c],
			[b, d],
			[c, d],
		] as const) {
			expect((job(after).startedAt as string) >= (job(before).finishedAt as string)).toBe(true);
		}
		expect(job(d).after).toEqual([b, c]);
	});

	test("a failed dependency skips its dependents down the chain; any-outcome still runs", async () => {
		const a = await sb.start(["-g", "f", "FAIL"]);
		const b = await sb.start(["-g", "f", "--after", a, "WRITE b.txt"]);
		const c = await sb.start(["-g", "f", "--after", b, "WRITE c.txt"]);
		const d = await sb.start(["-g", "f", "--after", a, "--after-any-outcome", "WRITE d.txt"]);
		const r = await sb.cli(["wait", "--group", "f"], [1]);
		expect(r.stdout).toContain("2 skipped");
		expect(sb.jobStatus(b)).toBe("skipped");
		expect(sb.job(b)?.errors).toContain(`dependency ${a} ended failed`);
		expect(sb.job(c)?.errors).toContain(`dependency ${b} ended skipped`);
		expect(sb.jobStatus(d)).toBe("completed");
		expect(existsSync(join(sb.repo, "b.txt"))).toBe(false);
		expect(existsSync(join(sb.repo, "d.txt"))).toBe(true);
	});

	test("a blocked job can be cancelled; its dependents are then skipped", async () => {
		const a = await sb.start(["--access", "read", "SLEEP"]);
		const b = await sb.start(["--after", a, "hello"]);
		const c = await sb.start(["--after", b, "hello"]);
		expect(sb.jobStatus(b)).toBe("blocked");
		await sb.cli(["cancel", b]);
		expect(sb.jobStatus(b)).toBe("cancelled");
		expect(sb.jobStatus(c)).toBe("skipped");
		await sb.cli(["cancel", a]);
	});

	test("{{result:<job>}} pastes a dependency's report into the prompt", async () => {
		const a = await sb.start(["first"]);
		const b = await sb.start(["--after", a, `Build on this: {{result:${a}}}`]);
		await sb.waitJson(b);
		const sent = readFileSync(join(sb.stateDir, "jobs", b, "prompt-sent.md"), "utf8");
		expect(sent).toContain("Build on this: ## Summary\nDid it.");
	});

	test("--after an unknown job is a usage error", async () => {
		const r = await sb.cli(["run", "--after", "nope", "hello"], [2]);
		expect(r.stderr).toContain("no job matching 'nope'");
	});
});

describe("budgets", () => {
	test("--budget stops a job that spends more", async () => {
		const out = await sb.runJson(["--budget", "0.001", "SUBAGENT SLEEP"], [1]);
		expect(out.status).toBe("over_budget");
		expect(out.errors.join(" ")).toContain("budget");
	});

	test("a group that spent its budget starts no more jobs", async () => {
		sb.writeConfig({ groups: { g: { budget_usd: 0.001 } } });
		await sb.runJson(["-g", "g", "hello"]);
		const out = await sb.runJson(["-g", "g", "WRITE x.txt"], [1]);
		expect(out.status).toBe("over_budget");
		expect(out.errors.join(" ")).toContain("group g spent $0.0010 of its $0.001 budget");
		expect(existsSync(join(sb.repo, "x.txt"))).toBe(false);
	});

	test("the daily budget applies across jobs", async () => {
		sb.writeConfig({ daily_budget_usd: 0.001 });
		await sb.runJson(["hello"]);
		const out = await sb.runJson(["hello"], [1]);
		expect(out.status).toBe("over_budget");
		expect(out.errors.join(" ")).toContain("daily budget");
	});
});

describe("plan apply", () => {
	function writePlan(name: string, text: string): string {
		const file = join(sb.base, name);
		writeFileSync(file, text);
		return file;
	}

	test("creates a DAG from YAML, with briefs, defaults and result passing", async () => {
		writeFileSync(join(sb.base, "brief-c.md"), "WRITE c.txt\n");
		const plan = writePlan(
			"m4.yaml",
			[
				"group: demo",
				"max_concurrent: 2",
				"defaults: { access: read }",
				"tasks:",
				"  - name: a",
				"    prompt: first",
				"  - name: b",
				"    prompt: 'second, after {{result:a}}'",
				"    after: a",
				"  - name: c",
				"    brief: brief-c.md",
				"    access: edit",
				"    after: [a]",
				"  - name: d",
				"    prompt: last",
				"    after: [b, c]",
			].join("\n"),
		);
		const { stdout } = await sb.cli(["plan", "apply", plan, "--json"]);
		const res = JSON.parse(stdout) as { group: string; jobs: { name: string; id: string }[] };
		expect(res.group).toBe("demo");
		const id = Object.fromEntries(res.jobs.map((j) => [j.name, j.id]));
		await sb.cli(["wait", "--group", "demo"]);
		const jobs = await groupJobs("demo");
		expect(jobs.map((j) => j.status)).toEqual(Array(4).fill("completed"));
		expect(sb.job(id.c as string)?.access).toBe("edit");
		expect(sb.job(id.d as string)?.after).toEqual([id.b, id.c] as string[]);
		const sent = readFileSync(join(sb.stateDir, "jobs", id.b as string, "prompt-sent.md"), "utf8");
		expect(sent).toContain("second, after ## Summary");
		expect(existsSync(join(sb.repo, "c.txt"))).toBe(true);
		const summary = (await sb.cli(["summary", "demo"])).stdout;
		expect(summary).toContain("## group demo: 4 job(s)");
		expect(summary).toContain("max 2 at once");
		expect((await sb.cli(["status", "--group", "demo"])).stdout).toBe(summary);
		await sb.cli(["status", id.a as string, "--group", "demo"], [2]);
	});

	test("a cycle or an unknown dependency is rejected before anything runs", async () => {
		const cycle = writePlan(
			"cycle.yaml",
			"tasks:\n  - {name: a, prompt: x, after: b}\n  - {name: b, prompt: y, after: a}\n",
		);
		expect((await sb.cli(["plan", "apply", cycle], [2])).stderr).toContain("dependency cycle");
		const unknown = writePlan("unknown.yaml", "tasks:\n  - {name: a, prompt: x, after: zz}\n");
		expect((await sb.cli(["plan", "apply", unknown], [2])).stderr).toContain(
			"'zz' is neither a task in this plan nor a job",
		);
		const typo = writePlan(
			"typo.yaml",
			"defaults: {budget_usd: 1}\ntasks:\n  - {name: a, prompt: x}\n",
		);
		expect((await sb.cli(["plan", "apply", typo], [2])).stderr).toContain("budget_usd");
		expect((await sb.cli(["list", "--json"])).stdout.trim()).toBe("[]");
	});

	test("--dry-run prints the order without creating jobs", async () => {
		const plan = writePlan(
			"dry.json",
			JSON.stringify({
				tasks: [
					{ name: "late", prompt: "x", after: ["early"] },
					{ name: "early", prompt: "y" },
				],
			}),
		);
		const { stdout } = await sb.cli(["plan", "apply", plan, "--dry-run"]);
		const names = stdout
			.trim()
			.split("\n")
			.map((l) => l.split(" ")[0]);
		expect(names).toEqual(["early", "late"]);
	});
});

test("list --group filters by group", async () => {
	await sb.runJson(["-g", "x", "hello"]);
	await sb.runJson(["hello"]);
	const { stdout } = await sb.cli(["list", "--group", "x", "--json"]);
	const jobs = JSON.parse(stdout) as JobJson[];
	expect(jobs).toHaveLength(1);
	expect(jobs[0]?.group).toBe("x");
});

describe("groups across Claude sessions", () => {
	test("wait --group covers only this session's jobs, and a shared name is flagged", async () => {
		const mine = { OMP_TASK_CLAUDE_SESSION: "session-b" };
		const a = await sb.start(["--access", "read", "-g", "g", "SLEEP"], {
			OMP_TASK_CLAUDE_SESSION: "session-a",
		});
		await sb.waitForStatus(a, "running");
		const created = await sb.cli(
			["run", "--detach", "--access", "read", "-g", "g", "hello"],
			[0],
			mine,
		);
		expect(created.stderr).toContain(
			`also has 1 unfinished job(s) of another Claude session (${a})`,
		);
		const waited = await sb.cli(["wait", "--group", "g", "--max-wait", "30"], [0], mine);
		expect(waited.stdout).toContain("WAKE: done (1 completed)");
		expect(sb.jobStatus(a)).toBe("running");
		const summary = await sb.cli(["summary", "g"], [0], mine);
		expect(summary.stdout).toContain("[another session]");
		const other = await sb.cli(["wait", "--group", "g", "--max-wait", "1"], null, {
			OMP_TASK_CLAUDE_SESSION: "session-c",
		});
		expect(other.code).not.toBe(0);
		expect(other.stderr).toContain("all of other Claude sessions");
		await sb.cli(["cancel", a]);
	});
});
