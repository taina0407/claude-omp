/** `omp-task review`: targets, the read-only job, and the structured review it must hand in. */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argAfter, type JobJson, Sandbox } from "./helpers";

setDefaultTimeout(60_000);

let sb: Sandbox;

beforeEach(() => {
	sb = new Sandbox();
	sb.commitAll();
});

afterEach(async () => {
	await sb.dispose();
});

type ReviewJson = JobJson & {
	review: { verdict: string; findings: { title: string }[] } | null;
	review_of: { mode: string; target: string; focus: string | null } | null;
	job_dir: string;
};

async function review(args: string[], ok = [0]): Promise<ReviewJson> {
	const { stdout } = await sb.cli(["review", "--json", ...args], ok);
	return JSON.parse(stdout) as ReviewJson;
}

const diffOf = (job: ReviewJson) => readFileSync(join(job.job_dir, "review.diff"), "utf8");

describe("targets", () => {
	test("by default it reviews uncommitted changes, untracked files included", async () => {
		writeFileSync(join(sb.repo, "existing.txt"), "bye\n");
		writeFileSync(join(sb.repo, "new.txt"), "fresh\n");
		const out = await review(["--focus", "REVIEW"]);
		expect(out.status).toBe("completed");
		expect(out.access).toBe("read");
		expect(out.review_of).toEqual({
			mode: "standard",
			target: "the uncommitted changes",
			focus: "REVIEW",
		});
		expect(out.review?.verdict).toBe("request_changes");
		expect(out.review?.findings[0]?.title).toBe("Greeting is wrong");
		expect(diffOf(out)).toContain("+bye");
		expect(diffOf(out)).toContain("+fresh");
		const prompt = readFileSync(join(out.job_dir, "prompt.md"), "utf8");
		expect(prompt).toContain("+bye");
		expect(prompt).toContain(`${out.job_dir}/review.diff`);
		const argv = sb.ompArgv();
		expect(argAfter(argv, "--tools")).toContain("read");
		expect(argAfter(argv, "--add-dir")).toBe(out.job_dir);
	});

	test("the text output is the rendered review", async () => {
		writeFileSync(join(sb.repo, "existing.txt"), "bye\n");
		const { stdout } = await sb.cli(["review", "--focus", "REVIEW"]);
		expect(stdout).toContain("# Review of the uncommitted changes: REQUEST CHANGES");
		expect(stdout).toContain("1. **[high] Greeting is wrong** (`existing.txt:1`, confidence 0.90)");
		expect(stdout).toContain("WAKE: done (1 completed)");
	});

	test("--staged reviews only what is staged", async () => {
		writeFileSync(join(sb.repo, "staged.txt"), "in the index\n");
		sb.git("add", "staged.txt");
		writeFileSync(join(sb.repo, "existing.txt"), "not staged\n");
		const out = await review(["--staged", "--focus", "REVIEW"]);
		expect(diffOf(out)).toContain("+in the index");
		expect(diffOf(out)).not.toContain("not staged");
		expect(out.review_of?.target).toBe("the staged changes");
	});

	test("--commit and --base review committed history", async () => {
		writeFileSync(join(sb.repo, "second.txt"), "two\n");
		sb.commitAll("second");
		const commit = await review(["--commit", "HEAD", "--focus", "REVIEW"]);
		expect(commit.review_of?.target).toMatch(/^commit [0-9a-f]+ second$/);
		expect(diffOf(commit)).toContain("+two");
		const base = await review(["--base", "HEAD~1", "--focus", "REVIEW"]);
		expect(base.review_of?.target).toBe("the changes since HEAD~1");
		expect(diffOf(base)).toContain("+two");
	});

	test("--job reviews a worktree job's changes, reading files in its worktree", async () => {
		const job = await sb.runJson(["--isolate", "worktree", "WRITE made.txt"]);
		const out = await review(["--job", job.id, "--focus", "REVIEW"]);
		expect(diffOf(out)).toContain("made.txt");
		expect(out.cwd).toBe(sb.job(job.id)?.worktreePath as string);
		expect(existsSync(join(sb.repo, "made.txt"))).toBe(false);
	});

	test("a still running job cannot be reviewed", async () => {
		const job = await sb.start(["--isolate", "worktree", "SLEEP"]);
		await sb.waitForStatus(job, "running");
		const r = await sb.cli(["review", "--job", job], [2]);
		expect(r.stderr).toContain("still running");
		await sb.cli(["cancel", job]);
	});

	test("nothing to review, and two targets at once, are usage errors", async () => {
		expect((await sb.cli(["review"], [2])).stderr).toContain("nothing to review");
		expect((await sb.cli(["review", "--staged", "--commit", "HEAD"], [2])).stderr).toContain(
			"pick one of",
		);
	});

	test("a diff too large to paste is only referenced", async () => {
		writeFileSync(join(sb.repo, "existing.txt"), "x".repeat(100).concat("\n").repeat(2_000));
		const out = await review(["--focus", "REVIEW"]);
		const prompt = readFileSync(join(out.job_dir, "prompt.md"), "utf8");
		expect(prompt).toContain("too large to paste");
		expect(prompt).toContain("- existing.txt");
		expect(diffOf(out).length).toBeGreaterThan(150_000);
	});
});

describe("the submitted review", () => {
	test("an invalid submission is sent back and the corrected one is kept", async () => {
		writeFileSync(join(sb.repo, "existing.txt"), "bye\n");
		const out = await review(["--focus", "REVIEWBAD"]);
		expect(out.status).toBe("completed");
		expect(out.review?.verdict).toBe("request_changes");
		const feed = (await sb.cli(["watch", out.id, "--from-start", "--verbose"])).stdout;
		expect(feed).toContain("invalid review submission 1; sent back");
		expect(feed).toContain("REVIEW: request_changes, 1 finding(s)");
		expect(feed).toContain(
			"PROGRESS: told: submit_review rejected; nothing was recorded. Fix these",
		);
		expect(feed).toContain("- verdict:");
	});

	test("after three invalid submissions the job fails", async () => {
		writeFileSync(join(sb.repo, "existing.txt"), "bye\n");
		const out = await review(["--focus", "REVIEWWORSE"], [1]);
		expect(out.status).toBe("failed");
		expect(out.review).toBeNull();
		expect(out.errors.join("\n")).toContain("review rejected 3 times");
		expect(out.errors.join("\n")).toContain("without submitting a valid review");
	});

	test("a worker that never submits fails the review job", async () => {
		writeFileSync(join(sb.repo, "existing.txt"), "bye\n");
		const out = await review(["--focus", "skip it"], [1]);
		expect(out.status).toBe("failed");
		expect(out.errors).toContain("the worker ended without submitting a valid review");
	});

	test("--adversarial uses the adversarial prompt", async () => {
		writeFileSync(join(sb.repo, "existing.txt"), "bye\n");
		const out = await review(["--adversarial", "--focus", "REVIEW"]);
		expect(out.review_of?.mode).toBe("adversarial");
		expect(out.title).toBe("adversarial review: the uncommitted changes");
		expect(readFileSync(join(out.job_dir, "prompt.md"), "utf8")).toContain("adversarial reviewer");
	});
});
