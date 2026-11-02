/** The subagent status line's pure parts: which rows it decorates and what it writes. */
import { describe, expect, test } from "bun:test";
import {
	elapsed,
	fit,
	groupStatusText,
	jobStatusText,
	needsText,
	rowTarget,
} from "../src/cli/statusline";
import type { Job, Pending } from "../src/core/types";

const NOW = Date.parse("2026-11-03T10:10:00Z");

function job(fields: Partial<Job> = {}): Job {
	return {
		id: "20261103-170000-ab12",
		status: "running",
		title: "fix tests",
		createdAt: "2026-11-03T10:00:00+00:00",
		startedAt: "2026-11-03T10:05:00+00:00",
		finishedAt: null,
		durationS: null,
		model: "smol",
		modelResolved: null,
		modelUsed: "openai/gpt-6-luna",
		costUsd: 0.01234,
		after: [],
		claudeSession: null,
		...fields,
	} as Job;
}

function pending(fields: Partial<Pending> = {}): Pending {
	return {
		jobId: "20261103-170000-ab12",
		ref: "r1",
		kind: "approval",
		text: "Command: make test\nmore",
		tool: "bash",
		options: [],
		context: null,
		askedAt: "2026-11-03T10:09:00+00:00",
		...fields,
	};
}

describe("rowTarget", () => {
	test("omp job and group relays", () => {
		expect(
			rowTarget({ id: "a", agentType: "omp:job", description: "omp ab12: fix [smol]" }),
		).toEqual({ kind: "job", ref: "ab12" });
		expect(
			rowTarget({ id: "a", agentType: "omp:job", description: "omp group auth-2: 3 jobs" }),
		).toEqual({ kind: "group", name: "auth-2" });
		expect(
			rowTarget({ id: "a", agentType: "omp:job", label: "omp 20261103-170000-ab12: fix" }),
		).toEqual({ kind: "job", ref: "20261103-170000-ab12" });
	});

	test("every other row is left alone", () => {
		expect(rowTarget({ id: "a", agentType: "general-purpose", description: "omp ab12: x" })).toBe(
			null,
		);
		expect(rowTarget({ id: "a", agentType: "omp:job", description: "fix the tests" })).toBe(null);
		expect(rowTarget({ id: "a", agentType: "other:jobs", description: "omp ab12: x" })).toBe(null);
		expect(rowTarget({ id: "a", description: "omp ab12: x" })).toBe(null);
	});

	test("rows that are not rows, and finished relays, are left alone", () => {
		const row = { id: "a", agentType: "omp:job", description: "omp ab12: x" };
		for (const bad of [null, 3, "omp ab12: x", [], { ...row, id: 7 }, { ...row, description: 1 }]) {
			expect(rowTarget(bad)).toBe(null);
		}
		expect(rowTarget({ ...row, status: "running" })).toEqual({ kind: "job", ref: "ab12" });
		expect(rowTarget({ ...row, status: "pending" })).toEqual({ kind: "job", ref: "ab12" });
		for (const status of ["completed", "failed", "killed", "stopped"]) {
			expect(rowTarget({ ...row, status })).toBe(null);
		}
	});
});

describe("texts", () => {
	test("elapsed", () => {
		expect(elapsed(42)).toBe("42s");
		expect(elapsed(75)).toBe("1m15s");
		expect(elapsed(3700)).toBe("1h01m");
		expect(elapsed(-3)).toBe("0s");
	});

	test("a running job: state, elapsed, model, cost", () => {
		expect(jobStatusText({ job: job(), pending: [] }, NOW)).toBe(
			"running 5m00s · gpt-6-luna · $0.0123",
		);
	});

	test("a waiting job names what it waits on, without omp's Command: label", () => {
		const view = { job: job({ status: "waiting" }), pending: [pending(), pending({ ref: "r2" })] };
		expect(jobStatusText(view, NOW)).toBe(
			"waiting 5m00s · gpt-6-luna · $0.0123 · needs: approval bash: make test (+1)",
		);
		const q = pending({ kind: "question", tool: null, text: "Which table?" });
		expect(needsText({ job: job({ status: "waiting" }), pending: [q] })).toBe(
			"needs: question: Which table?",
		);
	});

	test("held items and interrupted jobs", () => {
		const held = pending({ heldUntil: "2026-11-03T12:00:00+00:00" });
		expect(needsText({ job: job({ status: "waiting" }), pending: [held] })).toBe(
			"held for user: approval bash: make test",
		);
		expect(needsText({ job: job({ status: "interrupted" }), pending: [] })).toBe(
			"needs: resume (the daemon restarted)",
		);
	});

	test("finished and blocked jobs", () => {
		const done = job({ status: "completed", durationS: 125, modelUsed: null, model: null });
		expect(jobStatusText({ job: done, pending: [] }, NOW)).toBe(
			"completed 2m05s · default · $0.0123",
		);
		const blocked = job({
			status: "blocked",
			startedAt: null,
			after: ["20261103-165900-cd34"],
		});
		expect(jobStatusText({ job: blocked, pending: [] }, NOW)).toBe(
			"blocked 10m00s · gpt-6-luna · $0.0123 · after cd34",
		);
	});

	test("a group: counts, cost and its first open item", () => {
		const waiting = job({ status: "waiting", id: "20261103-170000-ef56" });
		const jobs = [job(), job({ status: "completed" }), waiting, job()];
		expect(groupStatusText(jobs, { job: waiting, pending: [pending()] })).toBe(
			"1 waiting, 2 running, 1 completed · $0.0494 · ef56 needs: approval bash: make test",
		);
	});

	test("fit cuts to the row's width", () => {
		expect(fit("a  b\nc", 80)).toBe("a b c");
		expect(fit("x".repeat(30), 20)).toBe(`${"x".repeat(19)}…`);
		expect(fit("x".repeat(30), undefined)).toBe("x".repeat(30));
	});

	test("fit measures terminal cells: CJK and emoji take two", () => {
		const cjk = fit(`omp ab12: ${"修复测试".repeat(5)}`, 20);
		expect(cjk).toBe("omp ab12: 修复测试…");
		expect(Bun.stringWidth(cjk)).toBeLessThanOrEqual(20);
		const emoji = fit(`${"🚀".repeat(15)}`, 20);
		expect(emoji).toBe(`${"🚀".repeat(9)}…`);
		expect(fit("修复", 20)).toBe("修复");
	});
});
