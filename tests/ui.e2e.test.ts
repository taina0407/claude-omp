/**
 * What the plugin's Claude Code UI relies on: who answered (and that only the UI may answer as the
 * user), first answer wins, `--ref` when a job has several open items, `RESOLVED:` lines, the
 * session's snapshot and stream, `await-ref`, and daemons that are down or too old.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PendingState, UiSnapshot } from "../src/api/schema";
import { Store } from "../src/core/store";
import type { ResolvedItem } from "../src/core/types";
import { Sandbox } from "./helpers";

setDefaultTimeout(60_000);

const S = "sess-a";
const OTHER = "sess-b";
const asS = { OMP_TASK_CLAUDE_SESSION: S };

let sb: Sandbox;
const feeds: UiFeed[] = [];

beforeEach(() => {
	sb = new Sandbox();
});

afterEach(async () => {
	for (const f of feeds.splice(0)) f.kill();
	await sb.dispose();
});

type Line = Record<string, unknown>;

/** `omp-task ui-feed` running in the background, as the plugin's mod runs it. */
class UiFeed {
	readonly lines: Line[] = [];
	readonly proc: ReturnType<typeof Bun.spawn>;
	readonly exited: Promise<number>;

	constructor(session: string, env: Record<string, string> = {}) {
		this.proc = Bun.spawn(
			[...sb.cmd, "ui-feed", "--session", session, "--json-lines", "--no-start"],
			{ cwd: sb.repo, env: { ...sb.env, ...env }, stdout: "pipe", stderr: "pipe" },
		);
		const stdout = this.proc.stdout as ReadableStream<Uint8Array>;
		const read = (async () => {
			let buf = "";
			const decoder = new TextDecoder();
			for await (const chunk of stdout) {
				buf += decoder.decode(chunk, { stream: true });
				let nl = buf.indexOf("\n");
				while (nl >= 0) {
					this.lines.push(JSON.parse(buf.slice(0, nl)) as Line);
					buf = buf.slice(nl + 1);
					nl = buf.indexOf("\n");
				}
			}
		})();
		this.exited = read.then(() => this.proc.exited);
		feeds.push(this);
	}

	/** The first line (from the start) that matches. */
	async line(pred: (l: Line) => boolean, timeoutMs = 20_000): Promise<Line> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const hit = this.lines.find(pred);
			if (hit) return hit;
			await Bun.sleep(25);
		}
		throw new Error(`no matching ui-feed line; got ${JSON.stringify(this.lines)}`);
	}

	async token(): Promise<string> {
		return (await this.line((l) => typeof l.token === "string")).token as string;
	}

	kill(): void {
		this.proc.kill();
	}
}

/** The ref of the first PENDING: line of a `wait`. */
function pendingRef(stdout: string): string {
	const m = /^PENDING: .*\(ref (\S+)\)$/m.exec(stdout);
	if (!m) throw new Error(`no PENDING line in:\n${stdout}`);
	return m[1] as string;
}

function resolved(job: string, ref: string): ResolvedItem | null {
	const store = new Store(join(sb.stateDir, "state.db"));
	try {
		return store.getResolved(job, ref);
	} finally {
		store.close();
	}
}

async function awaitRef(job: string, ref: string, maxWait = "30"): Promise<PendingState> {
	const r = await sb.cli(["await-ref", job, ref, "--max-wait", maxWait, "--json"]);
	return JSON.parse(r.stdout) as PendingState;
}

async function processGone(pid: number, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await Bun.sleep(50);
	}
	return false;
}

describe("first answer wins", () => {
	test("the user answers first: Claude's approve exits 2, and wait reports RESOLVED once", async () => {
		const job = await sb.start(["BASH"], asS);
		const feed = new UiFeed(S);
		const token = await feed.token();
		const ref = pendingRef((await sb.cli(["wait", job], [0], asS)).stdout);

		await sb.cli(["approve", job, "--ref", ref, "--session", "--by", "user"], [0], {
			OMP_TASK_UI_TOKEN: token,
		});
		const late = await sb.cli(["approve", job, "--ref", ref], [2]);
		expect(late.stdout).toMatch(/^already decided by the user at \d\d:\d\d \(approve --session\)/);
		expect(late.stdout).toContain("re-arm your wait");

		const done = await sb.cli(["wait", job], [0]);
		expect(done.stdout).toContain(`RESOLVED: ${job} ${ref} by user (approve --session)`);
		expect(done.stdout).toContain("approval=Approve bash for this session");
		expect((await sb.cli(["wait", job], [0])).stdout).not.toContain("RESOLVED:");
		expect(resolved(job, ref)).toMatchObject({ by: "user", decision: "session", kind: "approval" });
		const feedLog = (await sb.cli(["watch", job, "--from-start", "--verbose"])).stdout;
		expect(feedLog).toContain("APPROVAL-SESSION");
	});

	test("an answer by Claude is recorded as Claude's and is never reported back", async () => {
		const job = await sb.start(["BASH"], asS);
		const ref = pendingRef((await sb.cli(["wait", job], [0])).stdout);
		await sb.cli(["approve", job, "--ref", ref]);
		const done = await sb.cli(["wait", job], [0]);
		expect(done.stdout).not.toContain("RESOLVED:");
		expect(resolved(job, ref)).toMatchObject({ by: "claude", decision: "approve" });
		const again = await sb.cli(["approve", job, "--ref", ref], [2]);
		expect(again.stdout).toContain("already decided by the orchestrator");
	});

	test("a question answered by the user keeps a preview of the answer", async () => {
		const job = await sb.start(["ASK"], asS);
		const feed = new UiFeed(S);
		const token = await feed.token();
		const ref = pendingRef((await sb.cli(["wait", job])).stdout);
		await sb.cli(["reply", job, "--ref", ref, "--by", "user", "green"], [0], {
			OMP_TASK_UI_TOKEN: token,
		});
		const late = await sb.cli(["reply", job, "--ref", ref, "red"], [2]);
		expect(late.stdout).toContain("already answered by the user at");
		expect(late.stdout).toContain('(answer: "green")');
		const done = await sb.cli(["wait", job], [0]);
		expect(done.stdout).toContain(`RESOLVED: ${job} ${ref} by user (answered)`);
		expect(done.stdout).toContain("answer=green");
	});

	test("--ref is required while a job has two open approvals", async () => {
		const job = await sb.start(["PAIR"]);
		const woke = await sb.cli(["wait", job], [0]);
		expect(woke.stdout.match(/^PENDING:/gm)).toHaveLength(2);
		const bare = await sb.cli(["approve", job], [2]);
		expect(bare.stdout).toContain("2 pending approvals; pick one with --ref: ap-pair-a, ap-pair-b");
		await sb.cli(["approve", job, "--ref", "ap-pair-b", "--deny"]);
		await sb.cli(["approve", job]); // one left: no --ref needed
		const out = await sb.waitJson(job);
		expect(out.result).toContain("pair-a=Approve pair-b=Deny");
	});
});

describe("the UI token", () => {
	test("--by user needs a live UI token of the job's own session", async () => {
		const other = await sb.start(["SLEEP"], { OMP_TASK_CLAUDE_SESSION: OTHER });
		const job = await sb.start(["BASH"], asS);
		const ref = pendingRef((await sb.cli(["wait", job], [0])).stdout);
		const asUser = (token?: string) =>
			sb.cli(
				["approve", job, "--ref", ref, "--by", "user"],
				[2],
				token ? { OMP_TASK_UI_TOKEN: token } : {},
			);

		expect((await asUser()).stdout).toContain("no valid UI token");
		expect((await asUser("made-up")).stdout).toContain("no valid UI token");
		const otherFeed = new UiFeed(OTHER);
		expect((await asUser(await otherFeed.token())).stdout).toContain("no valid UI token");

		const feed = new UiFeed(S);
		const token = await feed.token();
		feed.kill();
		await feed.exited;
		// Probe with a reply (there is no question, so a valid token would only exit 1).
		const deadline = Date.now() + 10_000;
		let code = 1;
		while (code !== 2 && Date.now() < deadline) {
			code = (
				await sb.cli(["reply", job, "--by", "user", "x"], [1, 2], { OMP_TASK_UI_TOKEN: token })
			).code;
		}
		expect(code).toBe(2);
		expect((await asUser(token)).stdout).toContain("no valid UI token");

		expect(sb.jobStatus(job)).toBe("waiting");
		await sb.cli(["approve", job, "--ref", ref, "--deny"]);
		await sb.cli(["cancel", other]);
	});

	test("the token never reaches the daemon or the workers", async () => {
		const envLog = join(sb.base, "worker-env.json");
		const job = await sb.start(["ENV"], {
			...asS,
			OMP_TASK_UI_TOKEN: "leak",
			FAKE_OMP_ENV_LOG: envLog,
		});
		await sb.waitJson(job);
		const env = JSON.parse(await Bun.file(envLog).text()) as Record<string, string>;
		expect(env.OMP_TASK_UI_TOKEN).toBeUndefined();
	});
});

describe("snapshots and the stream", () => {
	test("ui-state lists the session's jobs only, with their open items", async () => {
		const mine = await sb.start(["BASH"], asS);
		const theirs = await sb.start(["SLEEP"], { OMP_TASK_CLAUDE_SESSION: OTHER });
		await sb.waitForStatus(mine, "waiting");
		const snap = JSON.parse(
			(await sb.cli(["ui-state", "--session", S, "--json"])).stdout,
		) as UiSnapshot;
		expect(snap.daemon).toBe("up");
		expect(snap.decider).toBe("claude");
		expect(snap.jobs.map((j) => j.id)).toEqual([mine]);
		const [job] = snap.jobs;
		expect(job?.status).toBe("waiting");
		expect(job?.pending[0]).toMatchObject({ kind: "approval", tool: "bash", ref: "ap-bash" });
		expect(job?.lastActivity?.kind).toBe("approval");

		await sb.cli(["approve", mine, "--deny"]);
		await sb.waitJson(mine);
		const recent = JSON.parse((await sb.cli(["ui-state", "--session", S])).stdout) as UiSnapshot;
		expect(recent.jobs.map((j) => j.status)).toEqual(["completed"]);
		const none = JSON.parse(
			(await sb.cli(["ui-state", "--session", S, "--recent", "0"])).stdout,
		) as UiSnapshot;
		expect(none.jobs).toEqual([]);
		await sb.cli(["cancel", theirs]);
	});

	test("ui-feed sends a token, snapshots while jobs run, then ends; the daemon then idles out", async () => {
		const job = await sb.start(["SLEEP"], { ...asS, OMP_TASK_DAEMON_IDLE: "1" });
		await sb.waitForStatus(job, "running");
		const feed = new UiFeed(S);
		await feed.token();
		await feed.line((l) => (l.jobs as UiSnapshot["jobs"] | undefined)?.[0]?.status === "running");
		await sb.cli(["steer", job, "stop"]);
		await feed.line((l) => (l.jobs as UiSnapshot["jobs"] | undefined)?.[0]?.status === "completed");
		await feed.line((l) => l.end === true);
		expect(await feed.exited).toBe(0);
		const pid = JSON.parse((await sb.cli(["daemon", "status", "--json"])).stdout).pid as number;
		expect(await processGone(pid)).toBe(true);
	});

	test("ui-feed ends at once when the session has no active job", async () => {
		await sb.cli(["list"]); // a daemon, but no jobs
		const feed = new UiFeed(S);
		await feed.token();
		await feed.line((l) => l.end === true);
		expect(await feed.exited).toBe(0);
		expect(feed.lines[1]).toMatchObject({ daemon: "up", jobs: [] });
	});
});

describe("await-ref", () => {
	test("open until answered, then resolved; gone for an unknown ref", async () => {
		const job = await sb.start(["BASH"], asS);
		await sb.waitForStatus(job, "waiting");
		expect(await awaitRef(job, "ap-bash", "1")).toEqual({ state: "open" });
		const waiting = awaitRef(job, "ap-bash");
		await Bun.sleep(300);
		await sb.cli(["approve", job, "--ref", "ap-bash", "--rule", "make *"]);
		expect(await waiting).toMatchObject({
			state: "resolved",
			by: "claude",
			decision: "approve",
			rule: "make *",
		});
		expect(await awaitRef(job, "nope", "1")).toEqual({ state: "gone" });
		await sb.waitJson(job);
	});

	test("an approval that times out is resolved as expired", async () => {
		const job = await sb.start(["--approval-timeout", "1", "BASH"], asS);
		expect(await awaitRef(job, "ap-bash")).toMatchObject({ state: "resolved", by: "expired" });
		await sb.waitJson(job);
	});
});

describe("daemons that are down or too old", () => {
	test("--no-start reports a daemon that is down and does not start one", async () => {
		for (const cmd of ["ui-state", "ui-feed"]) {
			const r = await sb.cli([cmd, "--session", S, "--json", "--no-start"]);
			expect(JSON.parse(r.stdout)).toMatchObject({ daemon: "down" });
		}
		expect((await sb.cli(["daemon", "status"], [1])).stdout).toContain("not running");
	});

	test("a daemon without the UI routes is reported as outdated", async () => {
		// Stands in for a busy daemon of an earlier release on this state dir's socket.
		const dir = join(sb.env.XDG_RUNTIME_DIR as string, "claude-omp");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const key = new Bun.CryptoHasher("sha256").update(sb.stateDir).digest("hex").slice(0, 12);
		const old = Bun.serve({
			unix: join(dir, `${key}.sock`),
			fetch(req) {
				if (new URL(req.url).pathname === "/v1/health") {
					return Response.json({
						ok: true,
						version: "1.3.2",
						pid: process.pid,
						startedAt: "",
						activeJobs: 1,
					});
				}
				return Response.json(
					{ error: `no route GET ${new URL(req.url).pathname}` },
					{ status: 404 },
				);
			},
		});
		try {
			for (const cmd of ["ui-state", "ui-feed"]) {
				const r = await sb.cli([cmd, "--session", S, "--json", "--no-start"]);
				expect(JSON.parse(r.stdout)).toMatchObject({ daemon: "outdated", version: "1.3.2" });
			}
		} finally {
			old.stop(true);
		}
	});
});

describe("who decides (ui.decider and ui-mode)", () => {
	test("decider=user: wait stays asleep while the UI is connected, and hands over when it goes", async () => {
		sb.writeConfig({ ui: { decider: "user" } });
		const job = await sb.start(["BASH"], asS);
		const feed = new UiFeed(S);
		await feed.line((l) => Array.isArray(l.jobs) && JSON.stringify(l).includes('"approval"'));
		const snap = feed.lines.find((l) => Array.isArray(l.jobs)) as unknown as UiSnapshot;
		expect(snap.decider).toBe("user");
		expect(snap.deciderSource).toBe("config");

		const held = await sb.cli(["wait", job, "--max-wait", "3"], [3], asS);
		expect(held.stdout).not.toContain("PENDING:");

		feed.kill();
		const woken = await sb.cli(["wait", job, "--max-wait", "20"], [0], asS);
		const ref = pendingRef(woken.stdout);
		await sb.cli(["approve", job, "--ref", ref], [0]);
		await sb.cli(["wait", job], [0]);
	});

	test("decider=user without any UI behaves as claude", async () => {
		sb.writeConfig({ ui: { decider: "user" } });
		const job = await sb.start(["BASH"], asS);
		const ref = pendingRef((await sb.cli(["wait", job, "--max-wait", "20"], [0], asS)).stdout);
		await sb.cli(["approve", job, "--ref", ref], [0]);
	});

	test("ui-mode sets the session's decider; default returns to the config; it needs the UI token", async () => {
		sb.writeConfig({ ui: { decider: "both", recent: "5m" } });
		const job = await sb.start(["BASH"], asS);
		const feed = new UiFeed(S);
		const token = await feed.token();
		const state = async () =>
			JSON.parse(
				(await sb.cli(["ui-state", "--session", S, "--json", "--no-start"])).stdout,
			) as UiSnapshot;
		expect(await state()).toMatchObject({
			decider: "both",
			deciderSource: "config",
			ui: { decider: "both", notify: true, band: "auto", recentS: 300 },
		});

		await sb.cli(["ui-mode", "--session", S, "user"], [0], { OMP_TASK_UI_TOKEN: token });
		expect(await state()).toMatchObject({ decider: "user", deciderSource: "session" });
		// The UI is connected and the session decides by itself now: wait does not wake.
		expect((await sb.cli(["wait", job, "--max-wait", "2"], [3], asS)).stdout).not.toContain(
			"PENDING:",
		);

		await sb.cli(["ui-mode", "--session", S, "default"], [0], { OMP_TASK_UI_TOKEN: token });
		expect(await state()).toMatchObject({ decider: "both", deciderSource: "config" });

		await sb.cli(["ui-mode", "--session", S, "user"], [2]);
		await sb.cli(["ui-mode", "--session", OTHER, "user"], [2], { OMP_TASK_UI_TOKEN: token });
		await sb.cli(["ui-mode", "--session", S, "nobody"], [2], { OMP_TASK_UI_TOKEN: token });
		expect(await state()).toMatchObject({ decider: "both" });

		const ref = pendingRef((await sb.cli(["wait", job, "--max-wait", "20"], [0], asS)).stdout);
		await sb.cli(["approve", job, "--ref", ref], [0]);
	});

	test("ui-state with no daemon still carries the config's ui block", async () => {
		sb.writeConfig({ ui: { band: "off", notify: false } });
		const r = await sb.cli(["ui-state", "--session", S, "--json", "--no-start"]);
		expect(JSON.parse(r.stdout)).toEqual({
			daemon: "down",
			ui: { decider: "claude", notify: false, band: "off", recentS: 600 },
		});
	});
});

describe("what the UI sends", () => {
	test("an answer that starts with '-' goes through after --, as the UI passes it", async () => {
		const job = await sb.start(["ASK"], asS);
		const feed = new UiFeed(S);
		const token = await feed.token();
		const ref = pendingRef((await sb.cli(["wait", job], [0], asS)).stdout);
		await sb.cli(
			["reply", "--ref", ref, "--by", "user", "--quiet", "--", job, "--force is fine"],
			[0],
			{ OMP_TASK_UI_TOKEN: token },
		);
		expect(resolved(job, ref)).toMatchObject({ by: "user", answerPreview: "--force is fine" });
		// --quiet: ask_user already told Claude, so wait reports nothing.
		expect((await sb.cli(["wait", job], [0])).stdout).not.toContain("RESOLVED:");
	});

	test("await-ref never starts a daemon", async () => {
		const r = await sb.cli(["await-ref", "nope", "q-1", "--max-wait", "1", "--json"]);
		expect(JSON.parse(r.stdout)).toEqual({ state: "gone" });
		expect((await sb.cli(["daemon", "status"], [1])).stdout).toContain("not running");
	});
});
