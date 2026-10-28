/**
 * Contract tests against a real omp and a real model: they catch protocol drift the fake omp
 * cannot. Opt-in (they take minutes and spend a few cents):
 *
 *   bun run contract                         # model "smol"
 *   OMP_CONTRACT_MODEL=task bun run contract
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Sandbox } from "../helpers";

const enabled = Boolean(process.env.OMP_CONTRACT);
const model = process.env.OMP_CONTRACT_MODEL ?? "smol";
setDefaultTimeout(600_000);

let sb: Sandbox;

beforeAll(() => {
	if (!enabled) return;
	const omp = Bun.which("omp");
	if (!omp) throw new Error("omp is not on PATH");
	sb = new Sandbox();
	sb.env.OMP_TASK_OMP_BIN = omp;
	writeFileSync(join(sb.repo, "notes.txt"), "alpha\nbeta\n");
	sb.commitAll();
});

afterAll(async () => {
	if (enabled) await sb.dispose();
});

const run = (args: string[], ok = [0]) => sb.cli(["run", "-m", model, ...args], ok);
const idOf = (stdout: string) => stdout.match(/## omp job (\S+)/)?.[1] as string;

describe.skipIf(!enabled)(`real omp (${model})`, () => {
	let first: string;

	test("a read-only job completes with a session, a model and usage", async () => {
		const out = await sb.runJson(["-m", model, "-a", "read", "Reply with exactly the word PONG."]);
		expect(out.status).toBe("completed");
		expect(out.result).toContain("PONG");
		expect(out.session_id).toBeTruthy();
		expect(out.model_used).toBeTruthy();
		expect(out.tokens as number).toBeGreaterThan(0);
		first = out.id;
	});

	test("continue resumes the same omp session", async () => {
		const { stdout } = await sb.cli([
			"continue",
			first,
			"--json",
			"What single word did you reply with before?",
		]);
		const child = JSON.parse(stdout);
		expect(child.status).toBe("completed");
		expect(child.result).toContain("PONG");
		expect(child.session_id).toBe(sb.job(first)?.sessionId as string);
	});

	test("a question wakes the orchestrator and the reply reaches the worker", async () => {
		const asked = await run(
			[
				"-a",
				"read",
				"Use the ask_orchestrator tool to ask which color to use, offering red and blue. Then reply with only the color you were told.",
			],
			[0],
		);
		expect(asked.stdout).toContain("QUESTION from worker");
		const id = idOf(asked.stdout);
		await sb.cli(["reply", id, "blue"]);
		expect((await sb.waitJson(id)).result.toLowerCase()).toContain("blue");
	});

	test("a shell approval wakes the orchestrator; an allow rule does not", async () => {
		const prompt =
			"Run the shell command `ls` once in the current directory, then reply with the number of entries it printed.";
		const asked = await run(["-a", "edit", prompt], [0]);
		expect(asked.stdout).toContain("APPROVAL needed");
		const id = idOf(asked.stdout);
		await sb.cli(["approve", id]);
		expect((await sb.waitJson(id)).status).toBe("completed");

		const auto = await sb.runJson(["-m", model, "-a", "edit", "--allow", "ls*", prompt]);
		expect(auto.status).toBe("completed");
		const feed = (await sb.cli(["watch", auto.id, "--from-start", "--verbose"])).stdout;
		expect(feed).toContain("AUTO-APPROVE");
	});

	test("a checkpoint wakes wait once", async () => {
		const id = await sb.start([
			"-m",
			model,
			"-a",
			"read",
			"First call notify_orchestrator with message 'plan ready' and checkpoint set to true. Then read notes.txt and reply with its first line.",
		]);
		const woke = await sb.cli(["wait", id], [0]);
		expect(woke.stdout).toContain("CHECKPOINT: plan ready");
		expect((await sb.cli(["wait", id])).stdout).toContain("WAKE: done");
	});

	test("a review hands in a schema-valid review", async () => {
		writeFileSync(
			join(sb.repo, "last.ts"),
			"export function last(xs: number[]): number {\n\treturn xs[xs.length];\n}\n",
		);
		const { stdout } = await sb.cli(["review", "--json", "-m", model]);
		const out = JSON.parse(stdout);
		expect(out.status).toBe("completed");
		expect(["approve", "approve_with_comments", "request_changes"]).toContain(out.review.verdict);
		expect(out.review.findings.length).toBeGreaterThan(0);
	});

	test("cancel stops a running worker", async () => {
		const id = await sb.start([
			"-m",
			model,
			"-a",
			"read",
			"Write a 3000-word essay about the history of version control, in one reply.",
		]);
		await sb.waitForStatus(id, "running", 120_000);
		await sb.cli(["cancel", id]);
		expect((await sb.waitJson(id)).status).toBe("cancelled");
	});
});
