/**
 * Open questions and approvals: the first answer wins, `--ref` when a job has several open items,
 * `RESOLVED:` lines for items a rule or a timeout settled, and `hold` (the orchestrator put an
 * item to the user: `wait` stops waking for it and it gets its own expiry).
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { Store } from "../src/core/store";
import type { ResolvedItem } from "../src/core/types";
import { Sandbox } from "./helpers";

setDefaultTimeout(60_000);

let sb: Sandbox;

beforeEach(() => {
	sb = new Sandbox();
});

afterEach(async () => {
	await sb.dispose();
});

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

describe("first answer wins", () => {
	test("an answer by Claude is recorded as Claude's and is never reported back", async () => {
		const job = await sb.start(["BASH"]);
		const ref = pendingRef((await sb.cli(["wait", job], [0])).stdout);
		await sb.cli(["approve", job, "--ref", ref]);
		const done = await sb.cli(["wait", job], [0]);
		expect(done.stdout).not.toContain("RESOLVED:");
		expect(resolved(job, ref)).toMatchObject({ by: "claude", decision: "approve" });
		const again = await sb.cli(["approve", job, "--ref", ref], [2]);
		expect(again.stdout).toContain("already decided by the orchestrator");
		expect(again.stdout).toContain("re-arm your wait");
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

	test("an approval that expires after wait showed it is reported once as RESOLVED", async () => {
		const job = await sb.start(["BASH", "--approval-timeout", "1"]);
		const ref = pendingRef((await sb.cli(["wait", job], [0])).stdout);
		await sb.waitForStatus(job, "completed");
		const done = await sb.cli(["wait", job], [0, 1]);
		expect(done.stdout).toContain(`RESOLVED: ${job} ${ref} by expired (approve --deny)`);
		expect((await sb.cli(["wait", job], [0, 1])).stdout).not.toContain("RESOLVED:");
	});
});

describe("hold", () => {
	test("a held item neither wakes wait nor expires on the usual timeout; reply still works", async () => {
		const job = await sb.start(["ASK", "--answer-timeout", "1"]);
		const ref = pendingRef((await sb.cli(["wait", job], [0])).stdout);
		const held = await sb.cli(["hold", job, "--ref", ref]);
		expect(held.stdout).toContain(`held ${ref} for the user`);

		// The answer timeout (1s) passes; the item stays open and wait sleeps through it.
		const asleep = await sb.cli(["wait", job, "--max-wait", "3"], [3]);
		expect(asleep.stdout).not.toContain("PENDING:");
		expect(sb.jobStatus(job)).toBe("waiting");

		const status = await sb.cli(["status", job, "--json"]);
		const pending = (
			JSON.parse(status.stdout) as { pending: { id: string; held_until?: string }[] }
		).pending;
		expect(pending).toHaveLength(1);
		expect(pending[0]?.held_until).toBeString();
		expect((await sb.cli(["status", job])).stdout).toContain(`HELD for the user (ref ${ref}`);

		await sb.cli(["reply", job, "--ref", ref, "green"]);
		const out = await sb.waitJson(job);
		expect(out.status).toBe("completed");
		expect(out.result).toContain("green");
		expect(resolved(job, ref)).toMatchObject({ by: "claude", answerPreview: "green" });
	});

	test("the job's --timeout does not run while every open item is held", async () => {
		const job = await sb.start(["ASK", "--timeout", "3", "--answer-timeout", "1"]);
		const ref = pendingRef((await sb.cli(["wait", job], [0])).stdout);
		await sb.cli(["hold", job, "--ref", ref]);
		await sb.cli(["wait", job, "--max-wait", "6"], [3]);
		expect(sb.jobStatus(job)).toBe("waiting");
		// wait --json still lists the held item, marked, though it did not wake for it.
		const status = JSON.parse((await sb.cli(["status", job, "--json"])).stdout) as {
			pending: { id: string; held_until?: string }[];
		};
		expect(status.pending[0]).toMatchObject({ id: ref });
		await sb.cli(["reply", job, "--ref", ref, "blue"]);
		const out = await sb.waitJson(job);
		expect(out.status).toBe("completed");
		expect(out.result).toContain("blue");
	});

	test("wait --json keeps a held item (with held_until) next to the one that woke it", async () => {
		const job = await sb.start(["PAIR"]);
		await sb.cli(["wait", job], [0]);
		await sb.cli(["hold", job, "--ref", "ap-pair-a"]);
		const woke = JSON.parse(
			(await sb.cli(["wait", job, "--json"], [0])).stdout.split("\n\n")[0] as string,
		) as { pending: { id: string; held_until?: string }[] };
		const held = woke.pending.find((p) => p.id === "ap-pair-a");
		expect(held?.held_until).toBeString();
		expect(woke.pending.find((p) => p.id === "ap-pair-b")?.held_until).toBeUndefined();
		await sb.cli(["approve", job, "--ref", "ap-pair-a"]);
		await sb.cli(["approve", job, "--ref", "ap-pair-b"]);
		await sb.waitJson(job);
	});

	test("an item held before any wait showed it still reports its expiry", async () => {
		const job = await sb.start(["BASH"]);
		await sb.waitForStatus(job, "waiting");
		await sb.cli(["hold", job, "--for", "1s"]);
		await sb.waitForStatus(job, "completed");
		const done = await sb.cli(["wait", job], [0, 1]);
		expect(done.stdout).toContain(`RESOLVED: ${job} ap-bash by expired (approve --deny)`);
	});

	test("a held item expires after --for and is reported as RESOLVED", async () => {
		const job = await sb.start(["BASH"]);
		const ref = pendingRef((await sb.cli(["wait", job], [0])).stdout);
		await sb.cli(["hold", job, "--ref", ref, "--for", "1s"]);
		const done = await sb.cli(["wait", job, "--max-wait", "30"], [0, 1]);
		expect(done.stdout).toContain(`RESOLVED: ${job} ${ref} by expired (approve --deny)`);
		expect(resolved(job, ref)).toMatchObject({ by: "expired", decision: "deny" });
	});

	test("hold needs --ref when several items are open, and refuses a settled one", async () => {
		const job = await sb.start(["PAIR"]);
		await sb.cli(["wait", job], [0]);
		const bare = await sb.cli(["hold", job], [2]);
		expect(bare.stdout).toContain("2 pending items; pick one with --ref");
		await sb.cli(["hold", job, "--ref", "ap-pair-a"]);
		// The other item still wakes wait at once; the held one is not shown again.
		const woke = await sb.cli(["wait", job], [0]);
		expect(woke.stdout.match(/^PENDING:/gm)).toHaveLength(1);
		expect(woke.stdout).toContain("(ref ap-pair-b)");
		await sb.cli(["approve", job, "--ref", "ap-pair-b"]);
		await sb.cli(["approve", job, "--ref", "ap-pair-a", "--deny"]);
		await sb.waitJson(job);
		const late = await sb.cli(["hold", job, "--ref", "ap-pair-a"], [2]);
		expect(late.stdout).toContain("already decided by the orchestrator");
	});
});
