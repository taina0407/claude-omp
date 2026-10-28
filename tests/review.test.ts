import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderReview } from "../src/review/render";
import { REVIEW_INLINE_BYTES, reviewPrompt } from "../src/review/review";
import { type Review, reviewIssues, reviewSchema } from "../src/review/schema";
import { changedFilesOf } from "../src/review/target";

const GOLDEN = join(import.meta.dir, "golden/review.md");

const sample: Review = {
	verdict: "request_changes",
	summary: "The retry loop can spin forever, and one message is misleading.  ",
	findings: [
		{
			severity: "low",
			file: "src/log.ts",
			title: "Misleading message",
			detail: "Says 'saved' before the write finishes.",
			confidence: 0.5,
		},
		{
			severity: "critical",
			file: "src/retry.ts",
			line: 42,
			title: "Infinite retry",
			detail:
				"When the server returns 503 forever, `attempt` is never incremented.\nThe job hangs.",
			suggestion: "Increment attempt before `continue`.",
			confidence: 0.95,
		},
		{
			severity: "medium",
			file: "src/retry.ts",
			line: 7,
			title: "No jitter",
			detail: "All clients retry at the same instant.",
			suggestion: "  ",
			confidence: 0.7,
		},
	],
};

describe("renderReview", () => {
	test("matches the golden file (UPDATE_GOLDEN=1 rewrites it)", () => {
		const text = renderReview(sample, "the uncommitted changes");
		if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, text);
		expect(text).toBe(readFileSync(GOLDEN, "utf8"));
	});

	test("a clean review says so", () => {
		const text = renderReview({ verdict: "approve", summary: "Fine.", findings: [] }, "commit abc");
		expect(text).toBe("# Review of commit abc: APPROVE\n\nFine.\n\nNo findings.\n");
	});
});

describe("reviewSchema", () => {
	test("the sample is valid", () => {
		expect(reviewSchema.safeParse(sample).success).toBe(true);
	});

	test("issues name the bad fields", () => {
		const r = reviewSchema.safeParse({
			verdict: "maybe",
			summary: "x",
			findings: [{ severity: "huge", file: "a", title: "t", detail: "d", confidence: 2 }],
		});
		expect(r.success).toBe(false);
		const text = reviewIssues((r as { error: Parameters<typeof reviewIssues>[0] }).error);
		expect(text).toContain("- verdict:");
		expect(text).toContain("- findings.0.severity:");
		expect(text).toContain("- findings.0.confidence:");
	});
});

describe("reviewPrompt", () => {
	const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+```y```\n";

	test("a small diff is pasted inside a fence longer than any backtick run", () => {
		const p = reviewPrompt(
			"standard",
			{ label: "the staged changes", diff, files: ["a.ts"] },
			null,
		);
		expect(p).toContain("Change under review: the staged changes");
		expect(p).toContain("````diff\n");
		expect(p).toContain("+```y```\n````");
		// Only {{job_dir}} is left; createJob fills it in once the job has a directory.
		expect(p.replaceAll("{{job_dir}}", "")).not.toContain("{{");
		expect(p).toContain("{{job_dir}}/review.diff");
	});

	test("focus and mode change the prompt", () => {
		const p = reviewPrompt("adversarial", { label: "x", diff, files: ["a.ts"] }, "the locking");
		expect(p).toContain("adversarial reviewer");
		expect(p).toContain("Focus especially on: the locking");
	});

	test("a large diff is only referenced, with the file list", () => {
		const big = `${diff}${"+z\n".repeat(REVIEW_INLINE_BYTES / 3 + 10)}`;
		const p = reviewPrompt("standard", { label: "x", diff: big, files: ["a.ts", "b.ts"] }, null);
		expect(p).toContain("too large to paste");
		expect(p).toContain("- b.ts");
		expect(p.length).toBeLessThan(5_000);
	});
});

test("changedFilesOf reads diff headers", () => {
	expect(changedFilesOf("diff --git a/x y.ts b/x y.ts\n+1\ndiff --git a/old b/new\n")).toEqual([
		"x y.ts",
		"new",
	]);
});
