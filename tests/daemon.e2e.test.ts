/**
 * The daemon's lifecycle: started on demand exactly once, recovers jobs it was running when it
 * died (interrupted → resume), stops cleanly, and stops by itself when idle.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { argAfter, Sandbox } from "./helpers";

setDefaultTimeout(60_000);

let sb: Sandbox;

beforeEach(() => {
	sb = new Sandbox();
});

afterEach(async () => {
	await sb.dispose();
});

async function daemonPid(): Promise<number> {
	const { stdout } = await sb.cli(["daemon", "status", "--json"]);
	return (JSON.parse(stdout) as { pid: number }).pid;
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

describe("start on demand", () => {
	test("concurrent CLIs on a cold start end up with exactly one daemon", async () => {
		await Promise.all(Array.from({ length: 6 }, () => sb.cli(["list"])));
		const listening = sb
			.daemonLog()
			.split("\n")
			.filter((l) => l.includes('"listening"'));
		expect(listening).toHaveLength(1);
		expect(await daemonPid()).toBeGreaterThan(0);
	});

	test("an idle daemon stops by itself", async () => {
		await sb.cli(["run", "--json", "hello"], [0], { OMP_TASK_DAEMON_IDLE: "1" });
		const pid = await daemonPid();
		expect(await processGone(pid)).toBe(true);
		expect((await sb.cli(["daemon", "status"], [1])).stdout).toContain("not running");
		expect(sb.daemonLog()).toContain('"idle, stopping"');
	});

	test("daemon stop refuses to interrupt running jobs without --force", async () => {
		const job = await sb.start(["SLEEP"]);
		await sb.waitForStatus(job, "running");
		const r = await sb.cli(["daemon", "stop"], [2]);
		expect(r.stderr).toContain("--force");
		await sb.cli(["cancel", job]);
	});
});

describe("crash recovery", () => {
	test("kill -9 mid-job: the job is interrupted, and resume finishes it in the same session", async () => {
		const job = await sb.start(["SLEEP"]);
		await sb.waitForStatus(job, "running");
		const first = sb.ompArgv();
		process.kill(await daemonPid(), "SIGKILL");

		// The next command starts a fresh daemon, which finds the job orphaned.
		const waited = await sb.cli(["wait", job], [4]);
		expect(waited.stdout).toContain("INTERRUPTED");
		expect(waited.stdout).toContain(`omp-task resume ${job}`);
		expect(sb.jobStatus(job)).toBe("interrupted");

		const resumed = JSON.parse((await sb.cli(["resume", job, "--json"])).stdout);
		expect(resumed.id).toBe(job);
		expect(resumed.status).toBe("completed");
		expect(resumed.result).toContain("resumed=true");
		const second = sb.ompArgv();
		expect(second).not.toEqual(first);
		const session = argAfter(second, "--resume");
		expect(session).toBe(resumed.session_id);
		expect(second).not.toContain("--append-system-prompt");
	});

	test("recovery stops an omp worker that outlived its daemon before anyone resumes", async () => {
		const { stdout } = await sb.cli(["run", "--detach", "--json", "SLEEP"], [0], {
			FAKE_OMP_IGNORE_EOF: "1",
		});
		const job = (JSON.parse(stdout) as { id: string }).id;
		await sb.waitForStatus(job, "running");
		const ompPid = sb.job(job)?.ompPid as number;
		expect(ompPid).toBeGreaterThan(0);
		process.kill(await daemonPid(), "SIGKILL");
		await Bun.sleep(500);
		expect(await processGone(ompPid, 100)).toBe(false); // the orphan is still working
		await sb.cli(["wait", job], [4]);
		expect(await processGone(ompPid, 2_000)).toBe(true);
		expect(sb.daemonLog()).toContain("stopped an orphaned omp worker");
	});

	test("resuming a job interrupted before omp saved its session starts it over", async () => {
		const job = await sb.start(["SLOWSTART WRITE late.txt"]);
		await sb.waitForStatus(job, "running");
		process.kill(await daemonPid(), "SIGKILL");
		await sb.cli(["wait", job], [4]);
		const out = JSON.parse((await sb.cli(["resume", job, "--json"])).stdout);
		expect(out.status).toBe("completed");
		expect(out.changed_files).toEqual(["late.txt"]);
		const argvs = sb.ompArgvs();
		expect(argAfter(argvs.at(-2) as string[], "--resume")).toBeTruthy(); // tried to resume
		expect(argvs.at(-1)).not.toContain("--resume"); // then started over
		expect(argvs.at(-1)).toContain("--append-system-prompt");
		const feed = (await sb.cli(["watch", job, "--from-start", "--verbose"])).stdout;
		expect(feed).toContain("starting over");
	});

	test("a graceful stop interrupts running jobs instead of failing them", async () => {
		const job = await sb.start(["SLEEP"]);
		await sb.waitForStatus(job, "running");
		await sb.cli(["daemon", "stop", "--force"]);
		expect(sb.jobStatus(job)).toBe("interrupted");
		const feed = await sb.cli(["watch", job, "--from-start"]);
		expect(feed.stdout).toContain("INTERRUPTED:");
	});

	test("an interrupted job can be cancelled instead of resumed", async () => {
		const job = await sb.start(["SLEEP"]);
		await sb.waitForStatus(job, "running");
		await sb.cli(["daemon", "stop", "--force"]);
		await sb.cli(["cancel", job]);
		expect((await sb.waitJson(job)).status).toBe("cancelled");
	});

	test("with auto_resume, a restarted daemon resumes interrupted jobs by itself", async () => {
		sb.writeConfig({ auto_resume: true });
		const job = await sb.start(["SLEEP"]);
		await sb.waitForStatus(job, "running");
		process.kill(await daemonPid(), "SIGKILL");
		const out = await sb.waitJson(job);
		expect(out.status).toBe("completed");
		expect(out.result).toContain("resumed=true");
		expect(argAfter(sb.ompArgv(), "--resume")).toBe(out.session_id as string);
	});

	test("only interrupted jobs can be resumed", async () => {
		const done = await sb.runJson(["hello"]);
		const r = await sb.cli(["resume", done.id], [2]);
		expect(r.stderr).toContain("only interrupted jobs resume");
	});
});

describe("streaming", () => {
	test("wait blocks across several long-poll rounds until the job ends", async () => {
		const job = await sb.start(["SLEEP"]);
		await sb.waitForStatus(job, "running");
		const waiting = sb.cli(["wait", job, "--json"]);
		await Bun.sleep(300);
		await sb.cli(["steer", job, "wrap up"]);
		const out = JSON.parse((await waiting).stdout.split("\n\n")[0] as string);
		expect(out.status).toBe("completed");
	});

	test("watch picks up a pending question even when it starts late", async () => {
		const job = await sb.start(["ASK"]);
		await sb.waitForStatus(job, "waiting");
		const watching = sb.cli(["watch", job, "-q"]);
		await Bun.sleep(300);
		await sb.cli(["reply", job, "red"]);
		const { stdout } = await watching;
		expect(stdout.split("\n")[0]).toContain("QUESTION: Which color?");
		expect(stdout).toContain("DONE: completed");
	});
});
