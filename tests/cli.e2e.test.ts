/**
 * End-to-end tests for the v1 CLI against the fake omp (tests/fake-omp). Ported from the v0.2
 * suite (tests/test_omp_task.py) plus cases for what the M0 recordings showed. Every test gets
 * its own state dir and so its own daemon.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { argAfter, type JobJson, type Result, Sandbox } from "./helpers";

setDefaultTimeout(60_000);

let sb: Sandbox;
let env: Record<string, string>;
let base: string;

beforeEach(() => {
	sb = new Sandbox();
	env = sb.env;
	base = sb.base;
});

afterEach(async () => {
	await sb.dispose();
});

const cli = (args: string[], ok: number[] | null = [0]): Promise<Result> => sb.cli(args, ok);
const runJson = (args: string[], ok = [0]): Promise<JobJson> => sb.runJson(args, ok);
const start = (args: string[]): Promise<string> => sb.start(args);
const waitJson = (job: string, extra: string[] = [], ok = [0, 1]) => sb.waitJson(job, extra, ok);
const ompArgv = (): string[] => sb.ompArgv();
const waitForStatus = (job: string, status: string) => sb.waitForStatus(job, status);

describe("basics", () => {
	test("run reports result and changed files", async () => {
		const out = await runJson(["WRITE new.txt please"]);
		expect(out.status).toBe("completed");
		expect(out.changed_files).toEqual(["new.txt"]);
		expect(out.tools).toEqual({ write: 1 });
		expect(out.result).toContain("Did it");
		expect(out.session_id).toBeTruthy();
		expect(out.model_used).toBe("fake/fake-1");
		expect(out.cost_usd).toBe(0.001);
	});

	test("flags reach omp", async () => {
		await runJson(["-m", "smol", "-a", "read", "-t", "high", "hello"]);
		const argv = ompArgv();
		expect(argAfter(argv, "--mode")).toBe("rpc");
		expect(argAfter(argv, "--model")).toBe("smol");
		expect(argAfter(argv, "--tools")?.split(",")[0]).toBe("read");
		expect(argAfter(argv, "--thinking")).toBe("high");
		expect(argv).toContain("--append-system-prompt");
		expect(argv).toContain("--no-title");
		expect(argv).not.toContain("--no-ui");
	});

	test("default access is edit", async () => {
		await runJson(["hello"]);
		expect(argAfter(ompArgv(), "--approval-mode")).toBe("write");
	});

	test("preset from config", async () => {
		writeFileSync(
			env.OMP_TASK_CONFIG as string,
			JSON.stringify({ presets: { rev: { model: "slow", access: "full" } } }),
		);
		await runJson(["--preset", "rev", "hello"]);
		const argv = ompArgv();
		expect(argAfter(argv, "--model")).toBe("slow");
		expect(argAfter(argv, "--approval-mode")).toBe("yolo");
	});

	test("brief file", async () => {
		const brief = join(base, "brief.md");
		writeFileSync(brief, "# Do the thing\nWRITE from_brief.txt\n");
		const out = await runJson(["--brief", brief]);
		expect(out.title).toBe("Do the thing");
		expect(out.changed_files).toEqual(["from_brief.txt"]);
	});

	test("failure is reported with omp's stderr", async () => {
		const out = await runJson(["FAIL"], [1]);
		expect(out.status).toBe("failed");
		expect(out.errors.some((e) => e.includes("boom"))).toBe(true);
	});

	test("a final message with stopReason error fails the job", async () => {
		const out = await runJson(["ERROR"], [1]);
		expect(out.status).toBe("failed");
		expect(out.errors).toContain("provider exploded");
	});

	test("continue resumes the same session and inherits settings", async () => {
		const first = await runJson(["-m", "smol", "hello"]);
		const second = JSON.parse((await cli(["continue", first.id, "--json", "fix it"])).stdout);
		expect(second.session_id).toBe(first.session_id);
		expect(second.parent).toBe(first.id);
		const argv = ompArgv();
		expect(argAfter(argv, "--resume")).toBe(first.session_id as string);
		expect(argAfter(argv, "--model")).toBe("smol");
		expect(argv).not.toContain("--append-system-prompt");
		expect(second.result).toContain("resumed=true");
	});

	test("subagent cost is added to the job's cost", async () => {
		const out = await runJson(["SUBAGENT"]);
		expect(out.cost_usd).toBe(0.003);
	});
});

describe("live supervision", () => {
	test("a question returns attention (exit 4), then reply resumes the job", async () => {
		const proc = await cli(["run", "ASK then finish"], [4]);
		expect(proc.stdout).toContain("QUESTION from worker");
		expect(proc.stdout).toContain("option: red");
		const job = proc.stdout.split(/\s+/)[3] as string;
		await cli(["reply", job, "blue please"]);
		const out = await waitJson(job);
		expect(out.status).toBe("completed");
		expect(out.result).toContain("answer=blue please");
	});

	test("approval flow", async () => {
		const proc = await cli(["run", "BASH"], [4]);
		expect(proc.stdout).toContain("APPROVAL needed");
		expect(proc.stdout).toContain("make test");
		const job = proc.stdout.split(/\s+/)[3] as string;
		await cli(["approve", job, "--session"]);
		const out = await waitJson(job);
		expect(out.result).toContain("approval=Approve bash for this session");
	});

	test("a denied approval is recorded", async () => {
		const job = await start(["BASH"]);
		await waitForStatus(job, "waiting");
		await cli(["approve", job, "--deny"]);
		const out = await waitJson(job);
		expect(out.result).toContain("approval=Deny");
		expect(out.denied_tools).toEqual(["bash"]);
	});

	test("steer a running job", async () => {
		const job = await start(["SLEEP"]);
		await waitForStatus(job, "running");
		await cli(["steer", job, "do something else"]);
		const out = await waitJson(job);
		expect(out.status).toBe("completed");
		expect(out.result).toContain("steered=do something else");
	});

	test("cancel a running job", async () => {
		const job = await start(["SLEEP"]);
		await waitForStatus(job, "running");
		await cli(["cancel", job]);
		expect((await waitJson(job)).status).toBe("cancelled");
	});

	test("timeout aborts the job", async () => {
		const job = await start(["--timeout", "2", "SLEEP"]);
		expect((await waitJson(job)).status).toBe("timeout");
	});

	test("an unanswered question expires and the worker carries on", async () => {
		const job = await start(["--answer-timeout", "1", "ASK"]);
		const out = await waitJson(job, ["--no-attention"]);
		expect(out.status).toBe("completed");
		expect(out.result).toContain("answer=No answer from the orchestrator");
	});

	test("an unanswered approval expires as a denial", async () => {
		const job = await start(["--approval-timeout", "1", "BASH"]);
		const out = await waitJson(job, ["--no-attention"]);
		expect(out.result).toContain("approval=Deny");
		expect(out.denied_tools).toEqual(["bash"]);
	});

	test("control commands on a finished job are refused", async () => {
		const done = await runJson(["hello"]);
		const r = await cli(["steer", done.id, "too late"], [2]);
		expect(r.stderr).toContain("not running");
	});
});

describe("feed", () => {
	test("watch streams the feed and exits", async () => {
		const job = await start(["NOTIFY WRITE w.txt"]);
		const { stdout } = await cli(["watch", job, "--from-start", "--interval", "0.1"]);
		const kinds = stdout
			.trim()
			.split("\n")
			.map((l) => l.split(" ")[2]);
		expect(kinds[0]).toBe("STARTED:");
		expect(kinds).toContain("PROGRESS:");
		expect(kinds).toContain("TOOL:");
		expect(kinds.at(-1)).toBe("DONE:");
		expect(stdout).toContain("changed: w.txt");
	});

	test("watch --quiet hides progress", async () => {
		const job = await start(["NOTIFY WRITE w.txt"]);
		const { stdout } = await cli(["watch", job, "--from-start", "-q", "--interval", "0.1"]);
		expect(stdout).not.toContain("PROGRESS");
		expect(stdout).toContain("DONE");
	});
});

describe("housekeeping", () => {
	test("list and doctor", async () => {
		const first = await runJson(["hello"]);
		expect((await cli(["list"])).stdout).toContain(first.id);
		expect((await cli(["doctor"])).stdout).toContain("omp/0.0.0-fake");
	});

	test("job ids resolve by unique prefix or suffix", async () => {
		const first = await runJson(["hello"]);
		const suffix = first.id.slice(-4);
		expect(JSON.parse((await cli(["result", suffix, "--json"])).stdout).id).toBe(first.id);
	});

	test("usage errors exit 2", async () => {
		expect((await cli(["run"], [2])).stderr).toContain("no text given");
		expect((await cli(["status", "nope"], [2])).stderr).toContain("no job matching");
		expect((await cli(["bogus"], [2])).stderr).toContain("unknown command");
	});
});
