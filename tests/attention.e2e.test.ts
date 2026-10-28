/**
 * The orchestrator is woken only when it has something to do: a question, an approval, a
 * checkpoint the worker asked for, a stalled worker, or the end. Routine approvals are decided by
 * rules, and busy jobs stay silent.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Sandbox } from "./helpers";

setDefaultTimeout(60_000);

let sb: Sandbox;

beforeEach(() => {
	sb = new Sandbox();
});

afterEach(async () => {
	await sb.dispose();
});

describe("quiet by default", () => {
	test("a 50-tool job wakes wait once, and a piped watch prints only the end", async () => {
		const job = await sb.start(["TOOLS 50 WRITE a.txt"]);
		const watched = sb.cli(["watch", job, "--from-start"]);
		const waited = await sb.cli(["wait", job]);
		expect(waited.stdout).toContain("WAKE: done (1 completed)");
		expect(sb.job(job)?.tools.read).toBe(50);
		const lines = (await watched).stdout.trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("DONE: completed");
	});

	test("watch --verbose still shows every event", async () => {
		const job = await sb.start(["TOOLS 3 WRITE a.txt"]);
		await sb.waitJson(job);
		const { stdout } = await sb.cli(["watch", job, "--from-start", "--verbose"]);
		expect(stdout).toContain("TOOL: write: a.txt");
	});

	test("run --detach points at wait only", async () => {
		const { stdout } = await sb.cli(["run", "--detach", "hello"]);
		expect(stdout).toContain("omp-task wait");
		expect(stdout).not.toContain("watch");
		expect(stdout).not.toContain("Monitor");
	});

	test("a finished job's report is cut to 40 lines when wait wakes", async () => {
		const job = await sb.start(["hello"]);
		await sb.waitJson(job);
		const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
		await Bun.write(`${sb.stateDir}/jobs/${job}/result.md`, long);
		const { stdout } = await sb.cli(["wait", job]);
		expect(stdout).toContain("line 39");
		expect(stdout).not.toContain("line 40\n");
		expect(stdout).toContain(`omp-task result ${job} --full`);
	});
});

describe("checkpoints", () => {
	test("a checkpoint wakes wait once, with the note", async () => {
		const job = await sb.start(["CHECKPOINT SLEEP"]);
		const first = await sb.cli(["wait", job], [4]);
		expect(first.stdout).toContain("CHECKPOINT: design done");
		expect(first.stdout).toContain(`WAKE: ${job} checkpoint`);
		// Delivered once: the next wait keeps waiting.
		await sb.cli(["wait", job, "--max-wait", "1"], [3]);
		await sb.cli(["steer", job, "go on"]);
		expect((await sb.waitJson(job)).status).toBe("completed");
	});

	test("wait --no-checkpoint ignores checkpoints", async () => {
		const job = await sb.start(["CHECKPOINT SLEEP"]);
		await sb.waitForStatus(job, "running");
		await Bun.sleep(300);
		await sb.cli(["wait", job, "--no-checkpoint", "--max-wait", "1"], [3]);
		await sb.cli(["cancel", job]);
	});

	test("a plain progress note never wakes wait", async () => {
		const job = await sb.start(["NOTIFY SLEEP"]);
		await sb.waitForStatus(job, "running");
		await sb.cli(["wait", job, "--max-wait", "1"], [3]);
		await sb.cli(["cancel", job]);
	});
});

describe("stalled workers", () => {
	test("no activity for --stall-timeout wakes wait", async () => {
		const job = await sb.start(["--stall-timeout", "1", "SLEEP"]);
		const r = await sb.cli(["wait", job], [4]);
		expect(r.stdout).toContain("STALLED: no worker activity for 1s");
		expect(r.stdout).toContain(`omp-task cancel ${job}`);
		await sb.cli(["cancel", job]);
	});

	test("the same failing call three times wakes wait", async () => {
		const job = await sb.start(["FLAKY SLEEP"]);
		const r = await sb.cli(["wait", job], [4]);
		expect(r.stdout).toContain("STALLED: the same call failed 3 times: bash: bun test");
		await sb.cli(["cancel", job]);
	});
});

describe("approval rules", () => {
	test("--allow approves a matching command without asking", async () => {
		const out = await sb.runJson(["--allow", "make *", "BASH"]);
		expect(out.status).toBe("completed");
		expect(out.result).toContain("approval=Approve");
		const feed = (await sb.cli(["watch", out.id, "--from-start", "--verbose"])).stdout;
		expect(feed).toContain("AUTO-APPROVE: bash: Command: make test");
	});

	test("--deny wins over --allow", async () => {
		const out = await sb.runJson(["--allow", "make *", "--deny", "make t*", "BASH"]);
		expect(out.result).toContain("approval=Deny");
		expect(out.denied_tools).toEqual(["bash"]);
	});

	test("an allow rule never approves a chained command", async () => {
		const r = await sb.cli(["run", "--allow", "make *", "BASHCHAIN"], [4]);
		expect(r.stdout).toContain("APPROVAL needed");
		expect(r.stdout).toContain("make test && rm -rf build");
		const job = r.stdout.split(/\s+/)[3] as string;
		await sb.cli(["approve", job, "--deny"]);
	});

	test("rules from the config defaults apply too", async () => {
		sb.writeConfig({ defaults: { allow: ["make test"] } });
		const out = await sb.runJson(["BASH"]);
		expect(out.result).toContain("approval=Approve");
	});
});
