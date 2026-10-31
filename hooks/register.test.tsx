/**
 * The mod against the engine's test kit (`bun run test:mod`). Beneath the plugin, the test's own
 * hooks stand for the engine and for the `omp-task` CLI: `$.process.run` answers from a small
 * in-memory world, `$.process.spawn` plays the `ui-feed` stream.
 */
import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import type { OmpPending, OmpSnapshot } from "../types";

const S = "sess-a";
const J = "job12345abcdef";
const TOKEN = "tok-123";

type State =
	| { state: "open" }
	| {
			state: "resolved";
			by: string;
			decision: string | null;
			rule: string | null;
			answerPreview: string | null;
			at: string;
	  }
	| { state: "gone" };

const approval: OmpPending = {
	jobId: J,
	ref: "ap-1",
	kind: "approval",
	text: "bun test src/a.ts",
	tool: "bash",
	options: ["Approve", "Deny"],
	context: null,
	askedAt: "2026-10-31T10:00:00+00:00",
	shortened: false,
	subject: "bun test src/a.ts",
};

function question(options: string[]): OmpPending {
	return {
		...approval,
		ref: "q-1",
		kind: "question",
		text: "Which database?",
		subject: "Which database?",
		tool: null,
		options,
	};
}

function snapshot(
	pending: OmpPending[],
	decider: "claude" | "both" | "user" = "claude",
): OmpSnapshot {
	return {
		daemon: "up",
		version: "1.4.0",
		generatedAt: "2026-10-31T10:00:01+00:00",
		decider,
		deciderSource: "config",
		ui: { decider, notify: true, band: "auto", recentS: 600 },
		jobs: [
			{
				id: J,
				title: "Refactor auth",
				status: pending.length ? "waiting" : "running",
				model: "gpt-5.2",
				access: "edit",
				group: null,
				startedAt: "2026-10-31T10:00:00+00:00",
				finishedAt: null,
				durationS: null,
				costUsd: 0.18,
				budgetUsd: null,
				queueReason: null,
				worktreePath: null,
				lastActivity: { ts: "2026-10-31T10:00:00+00:00", kind: "tool", text: "edit src/a.ts" },
				pending,
				changedFiles: null,
				cwd: "/repo",
			},
		],
	};
}

/** The CLI and the engine beneath the mod. */
function world(on: On, snap: OmpSnapshot) {
	const w = {
		snap,
		/** What `await-ref` answers for each ref (open while not set). */
		refs: new Map<string, State>(),
		/** Answers `await-ref` instead of `refs` while set (n: how many times it was asked). */
		awaitRef: null as ((ref: string, n: number) => State) | null,
		/** Exit code and stdout of the next reply/approve. */
		control: { exitCode: 0, stdout: "sent" },
		runs: [] as { argv: string[]; env: Record<string, string> | undefined }[],
		opened: [] as string[],
		notified: [] as string[],
		placed: true,
		ask: null as unknown,
		sessionId: S,
		spawned: 0,
		/** Snapshots the ui-feed sends after its first one. */
		feedLater: [] as OmpSnapshot[],
		/** argv of each call (without the binary), filtered by command. */
		argvs(cmd: string): string[][] {
			return w.runs.filter((r) => r.argv[0] === cmd).map((r) => r.argv);
		},
	};
	mock.clock(on);
	on("session.start", (_, e) => ({ cwd: e.cwd }));
	on("classic.SessionStart", () => ({}));
	on("session.id", () => ({ value: w.sessionId }));
	on("command.register", (_, e) => ({ value: { command: e.name } }));
	on("tool.register", (_, e) => ({ value: { tool: `mcp__omp__${e.name}` } }));
	on("ui.open", (_, e) => {
		w.opened.push(e.id);
		return {
			value:
				w.placed || e.id !== "omp-dialog"
					? { isPlaced: true }
					: { isPlaced: false, reason: "narrow" },
		};
	});
	on("ui.close", () => ({ value: undefined }));
	on("ui.toast", () => ({ value: undefined }));
	on("ui.notify", (_, e) => {
		w.notified.push(e.text);
		return { value: { isSent: true, channel: "terminal_bell" } };
	});
	on("tool.call", { tool: "AskUserQuestion" }, () => w.ask as { result: unknown });
	on("process.run", (_, e) => {
		const argv = e.argv.slice(1);
		w.runs.push({ argv, env: e.init?.env });
		const ok = (stdout: string, exitCode = 0) => ({
			value: { exitCode, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false },
		});
		const [cmd, , ref] = argv;
		if (cmd === "ui-state") return ok(JSON.stringify(w.snap));
		if (cmd === "await-ref") {
			const asked = w.argvs("await-ref").length;
			const st = w.awaitRef?.(ref as string, asked) ??
				w.refs.get(ref as string) ?? { state: "open" };
			return ok(JSON.stringify(st));
		}
		if (cmd === "approve" || cmd === "reply") {
			const r = argv[argv.indexOf("--ref") + 1] as string;
			if (w.control.exitCode === 0) {
				const decision =
					cmd === "reply"
						? null
						: argv.includes("--deny")
							? "deny"
							: argv.includes("--session")
								? "session"
								: "approve";
				w.refs.set(r, {
					state: "resolved",
					by: "user",
					decision,
					rule: null,
					answerPreview: cmd === "reply" ? (argv.at(-1) as string) : null,
					at: "2026-10-31T10:01:00+00:00",
				});
			}
			return ok(w.control.stdout, w.control.exitCode);
		}
		return ok("");
	});
	on("process.spawn", async function* () {
		w.spawned++;
		yield {
			stream: "stdout" as const,
			text: `${JSON.stringify({ token: TOKEN })}\n${JSON.stringify(w.snap)}\n`,
		};
		// Later snapshots, each a piece of its own.
		for (const next of w.feedLater) {
			yield { stream: "stdout" as const, text: `${JSON.stringify(next)}\n` };
		}
		return { value: { code: 0, signal: null } };
	});
	return w;
}

const BAND = {
	plugin: "omp",
	component: "AbovePrompt",
	props: {
		hasSurvey: false,
		isWorking: false,
		maxRows: 6,
		bodyColumns: 100,
		scroll: { offset: 0, bodyRows: 6 },
		view: {},
	},
} as const;

function pane(id: string) {
	return {
		plugin: "omp",
		component: "Pane",
		requestId: id,
		props: {
			title: id,
			isFocused: true,
			bodyColumns: 100,
			placement: "dock",
			scroll: { offset: 0, bodyRows: 30 },
			view: {},
		},
	} as const;
}

async function start($: Parameters<Parameters<typeof test>[1]>[0]) {
	await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });
}

test("the band counts the session's jobs; an item waits on Claude in the claude mode", async ($, on) => {
	world(on, snapshot([approval]));
	await start($);
	for (const surface of ["terminal", "desktop"] as const) {
		const ui = await $.ui.mount({ ...BAND, surface });
		const line = await ui.find({ type: "Text", text: /omp ▸/ });
		expect(line?.text).toContain("1 running");
		expect(line?.text).toContain("1 waiting on Claude");
		expect(line?.text).toContain("$0.18");
		expect(await ui.find({ key: "review" })).toBeUndefined();
		await ui.unmount();
	}
});

test("in the both mode a new item is the user's: the band says so and the dialog opens", async ($, on) => {
	const w = world(on, snapshot([approval], "both"));
	await start($);
	const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
	expect((await ui.find({ type: "Text", text: /omp ▸/ }))?.text).toContain("⚠ 1 needs you");
	await ui.unmount();
	expect(w.opened).toContain("omp-dialog");
	expect(w.notified).toEqual([`job ${J.slice(0, 8)} needs an approval: bun test src/a.ts`]);
});

/** Opens the approval dialog from the jobs pane's [Review], as the person would. */
async function review($: Parameters<Parameters<typeof test>[1]>[0], ref: string) {
	const list = await $.ui.mount({ ...pane("omp-jobs"), surface: "terminal" });
	await list.press({ key: `review-${J}-${ref}` });
	await list.unmount();
	return $.ui.mount({ ...pane("omp-dialog"), surface: "terminal" });
}

const BUTTONS: [string, string[]][] = [
	["a", []],
	["s", ["--same"]],
	["t", ["--session"]],
	["d", ["--deny"]],
];
for (const [key, extra] of BUTTONS) {
	test(`approval button ${key} runs approve ${extra.join(" ")} as the user`, async ($, on) => {
		const w = world(on, snapshot([approval]));
		await start($);
		const ui = await review($, "ap-1");
		expect(await ui.find({ type: "Text", text: /bun test src\/a\.ts/ })).toBeDefined();
		await ui.press({ key });
		await ui.unmount();
		expect(w.argvs("approve")).toEqual([
			["approve", "--ref", "ap-1", "--by", "user", ...extra, "--", J],
		]);
		const run = w.runs.find((r) => r.argv[0] === "approve");
		expect(run?.env).toEqual({ OMP_TASK_UI_TOKEN: TOKEN });
	});
}

test("ask_user holds until the item is settled and says how", async ($, on) => {
	const w = world(on, snapshot([approval]));
	await start($);
	w.awaitRef = (_ref, n) =>
		n < 3
			? { state: "open" }
			: {
					state: "resolved",
					by: "user",
					decision: "session",
					rule: null,
					answerPreview: null,
					at: "2026-10-31T10:01:00+00:00",
				};
	const res = (await $.tool.call({ tool: "mcp__omp__ask_user", job: J, ref: "ap-1" })) as {
		result: string;
	};
	expect(res.result).toBe(`answered by user: approve --session (job ${J}). Re-arm your wait.`);
	expect(w.opened).toContain("omp-dialog");
});

test("ask_user on an item that is gone says so and opens nothing", async ($, on) => {
	const w = world(on, snapshot([]));
	await start($);
	w.refs.set("ap-9", { state: "gone" });
	const res = (await $.tool.call({ tool: "mcp__omp__ask_user", job: J, ref: "ap-9" })) as {
		result: string;
	};
	expect(res.result).toMatch(/^gone: /);
	expect(w.opened).not.toContain("omp-dialog");
});

test("a rule the daemon refuses keeps the dialog open with its words", async ($, on) => {
	const w = world(on, snapshot([approval]));
	await start($);
	w.control = { exitCode: 2, stdout: "error: rule 'npm*' does not match this request" };
	const ui = await review($, "ap-1");
	await ui.press({ key: "r" });
	await ui.input({ key: "rule", text: "npm*" });
	expect(w.argvs("approve").at(-1)).toEqual([
		"approve",
		"--ref",
		"ap-1",
		"--by",
		"user",
		"--rule",
		"npm*",
		"--",
		J,
	]);
	expect((await ui.find({ type: "Text", text: /does not match/ }))?.text).toContain("rule 'npm*'");
	expect(await ui.find({ key: "rule" })).toBeDefined();
	w.control = { exitCode: 0, stdout: "sent" };
	await ui.input({ key: "rule", text: "bun test*" });
	await ui.unmount();
});

test("ask_user on a question of 3 options: the picked label sends the worker's whole option", async ($, on) => {
	const long = "Use the configuration from the shared workspace";
	const w = world(on, snapshot([question([long, "Postgres", "SQLite"])]));
	await start($);
	w.ask = { result: { answers: { "Which database?": "Use the configuration from the…" } } };
	const res = (await $.tool.call({ tool: "mcp__omp__ask_user", job: J, ref: "q-1" })) as {
		result: string;
	};
	expect(w.argvs("reply")).toEqual([
		["reply", "--ref", "q-1", "--by", "user", "--quiet", "--", J, long],
	]);
	expect(res.result).toMatch(/^answered by user: "Use the configuration/);
});

test("an answer the dialog gave while the user was away is not sent", async ($, on) => {
	const w = world(on, snapshot([question(["A", "B"])]));
	await start($);
	w.ask = { result: { answers: { "Which database?": "A" }, afkTimeoutMs: 60_000 } };
	const res = (await $.tool.call({ tool: "mcp__omp__ask_user", job: J, ref: "q-1" })) as {
		result: string;
	};
	expect(w.argvs("reply")).toEqual([]);
	expect(res.result).toMatch(/^dismissed: /);
});

test("nothing is sent for an item settled before the user answered", async ($, on) => {
	const w = world(on, snapshot([question(["A", "B"])]));
	await start($);
	w.ask = { result: { answers: { "Which database?": "A" } } };
	w.refs.set("q-1", {
		state: "resolved",
		by: "claude",
		decision: null,
		rule: null,
		answerPreview: "B",
		at: "2026-10-31T10:02:00+00:00",
	});
	const res = (await $.tool.call({ tool: "mcp__omp__ask_user", job: J, ref: "q-1" })) as {
		result: string;
	};
	expect(w.argvs("reply")).toEqual([]);
	expect(res.result).toMatch(/^already_resolved: settled by claude/);
});

test("a narrow terminal: the band offers [Review], which places the dialog", async ($, on) => {
	const w = world(on, snapshot([approval], "both"));
	w.placed = false;
	await start($);
	const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
	expect(await ui.find({ key: "review" })).toBeDefined();
	expect(w.notified.some((n) => n.includes("[Review]"))).toBe(true);
	w.placed = true;
	await ui.press({ key: "review" });
	expect(w.opened.filter((id) => id === "omp-dialog").length).toBe(2);
	await ui.unmount();
});

test("a new session id (/clear) reads the new session's jobs", async ($, on) => {
	const w = world(on, snapshot([]));
	await start($);
	w.sessionId = "sess-new";
	await $.classic.SessionStart({ source: "clear", session_id: "sess-new" });
	const states = w.argvs("ui-state").map((a) => a[2]);
	expect(states).toContain(S);
	expect(states.at(-1)).toBe("sess-new");
});

test("deny with a message denies, then steers the worker with it", async ($, on) => {
	const w = world(on, snapshot([approval]));
	await start($);
	const ui = await review($, "ap-1");
	await ui.press({ key: "m" });
	await ui.input({ key: "message", text: "use the fake database" });
	await ui.unmount();
	expect(w.argvs("approve")).toEqual([
		["approve", "--ref", "ap-1", "--by", "user", "--deny", "--", J],
	]);
	expect(w.argvs("steer")).toEqual([["steer", "--", J, "use the fake database"]]);
});

test("a question of 5 options goes to the pane; a number sends that option", async ($, on) => {
	const w = world(on, snapshot([question(["a", "b", "c", "d", "e"])]));
	await start($);
	const ui = await review($, "q-1");
	expect(await ui.find({ type: "Text", text: /Which database\?/ })).toBeDefined();
	await ui.input({ key: "answer", text: "2" });
	await ui.unmount();
	expect(w.argvs("reply")).toEqual([["reply", "--ref", "q-1", "--by", "user", "--", J, "b"]]);
});

test("switching to the user mode opens an item that was already open", async ($, on) => {
	const w = world(on, snapshot([approval]));
	w.feedLater = [snapshot([approval], "user")];
	await start($);
	const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
	expect((await ui.find({ type: "Text", text: /omp ▸/ }))?.text).toContain("⚠ 1 needs you");
	await ui.unmount();
	expect(w.opened).toContain("omp-dialog");
});

test("a headless session opens no UI stream (the daemon must not count it as a connected UI)", async ($, on) => {
	const w = world(on, snapshot([approval], "user"));
	await $.session.start({ cwd: "/repo", surface: null, isInteractive: false });
	expect(w.spawned).toBe(0);
	expect(w.argvs("ui-state")).toEqual([]);
});
