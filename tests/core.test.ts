import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editedPaths } from "../src/backends/omp-rpc/protocol";
import { ompVersionOk } from "../src/cli/main";
import { pickSetting } from "../src/core/config";
import { detachedEnv, workerEnv } from "../src/core/env";
import { Store } from "../src/core/store";
import type { JobSpec } from "../src/core/types";
import { firstLine, newJobId, parseDuration, shellSplit, UsageError } from "../src/core/util";

describe("parseDuration", () => {
	test.each([
		["90", 90],
		["20m", 1200],
		["1h30m", 5400],
		["1.5h", 5400],
		["7d", 604_800],
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

test("job ids sort by creation time", () => {
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

	test("reopening an existing database keeps its jobs", () => {
		withStore((s, path) => {
			s.createJob("20260101-000000-abcd", spec);
			const again = new Store(path);
			expect(again.getJob("20260101-000000-abcd")?.title).toBe("t");
			again.close();
		});
	});

	test("a database with another layout is reset", () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-store-"));
		const path = join(dir, "state.db");
		const old = new Database(path);
		old.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		old.run("INSERT INTO meta VALUES ('schema_version', '7')");
		old.run("CREATE TABLE jobs (id TEXT PRIMARY KEY)");
		old.run("INSERT INTO jobs VALUES ('20250101-000000-0000')");
		old.close();
		const store = new Store(path);
		try {
			expect(store.getJob("20250101-000000-0000")).toBeNull();
			store.createJob("20260101-000000-abcd", spec);
			expect(store.getJob("20260101-000000-abcd")?.title).toBe("t");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a database of layout omp-task/1 is upgraded in place, keeping its jobs", () => {
		withStore((s, path) => {
			s.createJob("20260101-000000-abcd", spec);
			s.db.run("ALTER TABLE jobs DROP COLUMN other_changes");
			s.db.run("UPDATE meta SET value = 'omp-task/1' WHERE key = 'schema'");
			const again = new Store(path);
			try {
				expect(again.getJob("20260101-000000-abcd")?.otherChanges).toBeNull();
				again.updateJob("20260101-000000-abcd", { otherChanges: ["x.txt"] });
				expect(again.getJob("20260101-000000-abcd")?.otherChanges).toEqual(["x.txt"]);
			} finally {
				again.close();
			}
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

	test("onChange fires for every job, feed and pending mutation", () => {
		withStore((s) => {
			const seen: string[] = [];
			s.onChange = (id) => seen.push(id);
			s.createJob("20260101-000000-abcd", spec);
			s.updateJob("20260101-000000-abcd", { status: "running" });
			s.appendFeed("20260101-000000-abcd", "started");
			s.addPending({
				jobId: "20260101-000000-abcd",
				ref: "q1",
				kind: "question",
				text: "?",
				tool: null,
				options: [],
				context: null,
				askedAt: "now",
			});
			s.removePending("20260101-000000-abcd", "q1");
			expect(seen).toEqual(Array(4).fill("20260101-000000-abcd"));
		});
	});
});

test("doctor accepts omp 18.12 or later", () => {
	expect(ompVersionOk("omp/18.12.6")).toBe(true);
	expect(ompVersionOk("omp/19.0.1")).toBe(true);
	expect(ompVersionOk("omp/18.11.9")).toBe(false);
	expect(ompVersionOk("omp/17.40.0")).toBe(false);
	expect(ompVersionOk("")).toBe(true);
});

describe("worker environment", () => {
	const env = {
		PATH: "/bin",
		HOME: "/home/u",
		ANTHROPIC_API_KEY: "k",
		CLAUDE_CONFIG_DIR: "/c",
		CLAUDECODE: "1",
		CLAUDE_CODE_SESSION_ID: "starter",
		CLAUDE_CODE_MESSAGING_SOCKET: "/run/cc.sock",
		CLAUDE_PID: "42",
		OMP_TASK_CLAUDE_SESSION: "starter",
		ORCA_PANE_KEY: "pane",
		ORCA_TAB_ID: "tab",
		TMUX: "/tmp/tmux-1000/default,1,0",
		TMUX_PANE: "%11",
	};

	test("the daemon drops the identity of the session and pane that started it", () => {
		expect(detachedEnv(env)).toEqual({
			PATH: "/bin",
			HOME: "/home/u",
			ANTHROPIC_API_KEY: "k",
			CLAUDE_CONFIG_DIR: "/c",
			TMUX: "/tmp/tmux-1000/default,1,0",
		});
	});

	test("a worker carries its own job's Claude session, or none", () => {
		expect(workerEnv(env, "mine").OMP_TASK_CLAUDE_SESSION).toBe("mine");
		expect(workerEnv(env, null).OMP_TASK_CLAUDE_SESSION).toBeUndefined();
		expect(workerEnv(env, "mine").CLAUDE_CODE_SESSION_ID).toBeUndefined();
	});
});

describe("editedPaths", () => {
	test("edit and write calls name their path", () => {
		expect(editedPaths("edit", { path: "a.ts", old_string: "x", new_string: "y" })).toEqual([
			"a.ts",
		]);
		expect(editedPaths("write", { path: "/abs/b.ts", content: "" })).toEqual(["/abs/b.ts"]);
	});

	test("a patch-style edit names every file it touches", () => {
		const input = [
			"*** Begin Patch",
			"[README.md#5BBF]",
			"PUT 1.=1:",
			"+x",
			"*** Update File: src/a.ts",
			"*** Add File: src/new.ts",
			"*** Delete File: old.ts",
			"*** End Patch",
		].join("\n");
		expect(editedPaths("edit", { input })).toEqual([
			"README.md",
			"src/a.ts",
			"src/new.ts",
			"old.ts",
		]);
	});

	test("other tools change nothing the runner attributes", () => {
		expect(editedPaths("bash", { command: "touch x" })).toEqual([]);
		expect(editedPaths("read", { path: "a.ts" })).toEqual([]);
	});
});
