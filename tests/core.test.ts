import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickSetting } from "../src/core/config";
import { Store } from "../src/core/store";
import type { JobSpec } from "../src/core/types";
import { firstLine, newJobId, parseDuration, shellSplit, UsageError } from "../src/core/util";

describe("parseDuration", () => {
	test.each([
		["90", 90],
		["20m", 1200],
		["1h30m", 5400],
		["1.5h", 5400],
		[45, 45],
	])("%p → %p seconds", (input, seconds) => {
		expect(parseDuration(input)).toBe(seconds);
	});

	test("empty and zero mean no limit", () => {
		for (const v of [null, undefined, "", "0", 0]) expect(parseDuration(v)).toBeNull();
	});

	test("rejects garbage", () => {
		expect(() => parseDuration("soon")).toThrow(UsageError);
	});
});

describe("shellSplit", () => {
	test("handles quotes and escapes", () => {
		expect(shellSplit(`--a "b c" 'd "e"' f\\ g ""`)).toEqual(["--a", "b c", 'd "e"', "f g", ""]);
	});

	test("rejects an unterminated quote", () => {
		expect(() => shellSplit(`--x "oops`)).toThrow(UsageError);
	});
});

test("firstLine strips markdown markers", () => {
	expect(firstLine("\n\n# Do the thing\nmore")).toBe("Do the thing");
	expect(firstLine("   ")).toBe("(untitled)");
});

test("job ids sort by time and look like v0.2's", () => {
	expect(newJobId(new Date(2026, 9, 28, 9, 5, 7))).toMatch(/^20261028-090507-[0-9a-f]{4}$/);
});

test("settings precedence: flag > preset > parent > defaults > fallback", () => {
	const base = { preset: {}, parent: undefined, defaults: {} };
	expect(pickSetting("model", { ...base, flag: undefined }, "x")).toBe("x");
	expect(pickSetting("model", { ...base, flag: undefined, defaults: { model: "d" } })).toBe("d");
	expect(
		pickSetting("model", {
			flag: undefined,
			preset: {},
			parent: { model: "p" },
			defaults: { model: "d" },
		}),
	).toBe("p");
	expect(
		pickSetting("model", {
			flag: undefined,
			preset: { model: "s" },
			parent: { model: "p" },
			defaults: {},
		}),
	).toBe("s");
	expect(pickSetting("model", { ...base, flag: "f", preset: { model: "s" } })).toBe("f");
});

describe("Store", () => {
	const spec: JobSpec = {
		title: "t",
		cwd: "/tmp",
		access: "edit",
		model: null,
		thinking: null,
		timeoutS: 60,
		answerTimeoutS: null,
		approvalTimeoutS: null,
		addDirs: [],
		files: [],
		extraArgs: ["--x"],
		noPreamble: false,
		parentId: null,
		resumeSession: null,
	};

	function withStore(fn: (s: Store, path: string) => void) {
		const dir = mkdtempSync(join(tmpdir(), "omp-store-"));
		const path = join(dir, "state.db");
		const store = new Store(path);
		try {
			fn(store, path);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test("round-trips a job, including JSON and boolean columns", () => {
		withStore((s) => {
			s.createJob("20260101-000000-abcd", spec);
			s.updateJob("20260101-000000-abcd", { tools: { read: 2 }, changedFiles: null });
			const job = s.getJob("20260101-000000-abcd");
			expect(job?.status).toBe("queued");
			expect(job?.extraArgs).toEqual(["--x"]);
			expect(job?.noPreamble).toBe(false);
			expect(job?.tools).toEqual({ read: 2 });
			expect(job?.changedFiles).toBeNull();
		});
	});

	test("reopening an existing database does not re-run migrations", () => {
		withStore((s, path) => {
			s.createJob("20260101-000000-abcd", spec);
			const again = new Store(path);
			expect(again.getJob("20260101-000000-abcd")?.title).toBe("t");
			again.close();
		});
	});

	test("finds jobs by unique prefix or suffix", () => {
		withStore((s) => {
			s.createJob("20260101-000000-abcd", spec);
			s.createJob("20260101-000001-ef01", spec);
			expect(s.findJobIds("ef01")).toEqual(["20260101-000001-ef01"]);
			expect(s.findJobIds("20260101-00000")).toHaveLength(2);
		});
	});

	test("feed sequence numbers are per job and increasing", () => {
		withStore((s) => {
			s.appendFeed("a", "started");
			s.appendFeed("a", "tool", "x");
			s.appendFeed("b", "started");
			expect(s.feedSince("a", 0).map((e) => e.seq)).toEqual([1, 2]);
			expect(s.feedSince("a", 1).map((e) => e.kind)).toEqual(["tool"]);
			expect(s.lastFeedSeq("b")).toBe(1);
		});
	});

	test("commands are queued, handled once, and carry their result", () => {
		withStore((s) => {
			const id = s.enqueueCommand("a", "reply", { message: "blue", ref: null });
			expect(s.openCommands("a").map((c) => c.payload.message)).toEqual(["blue"]);
			s.completeCommand(id, { ok: true, ref: "q1" });
			expect(s.openCommands("a")).toHaveLength(0);
			expect(s.getCommand(id)?.result).toEqual({ ok: true, ref: "q1" });
		});
	});
});
