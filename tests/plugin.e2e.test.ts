/** The Claude Code plugin layer: hooks, setup, the bin launcher and the plugin's files. */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Sandbox } from "./helpers";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
let sb: Sandbox;

beforeEach(() => {
	sb = new Sandbox();
});

afterEach(async () => {
	await sb.dispose();
});

function daemonRunning(): boolean {
	return existsSync(join(sb.stateDir, "daemon.lock"));
}

describe("session hooks", () => {
	test("session-start exports the session id for later omp-task calls", async () => {
		const envFile = join(sb.base, "claude.env");
		writeFileSync(envFile, "");
		const r = await sb.hook(
			"session-start",
			{ session_id: "abc-123" },
			{ CLAUDE_ENV_FILE: envFile },
		);
		expect(r.code).toBe(0);
		expect(readFileSync(envFile, "utf8")).toBe("export OMP_TASK_CLAUDE_SESSION=abc-123\n");
		expect(daemonRunning()).toBe(false);
	});

	test("jobs remember their Claude session; on_session_end cancel cancels them", async () => {
		sb.writeConfig({ on_session_end: "cancel" });
		const env = { OMP_TASK_CLAUDE_SESSION: "s1" };
		const mine = JSON.parse(
			(await sb.cli(["run", "--detach", "--json", "--access", "read", "SLEEP"], [0], env)).stdout,
		).id as string;
		const other = await sb.start(["--access", "read", "SLEEP"]);
		await sb.waitForStatus(mine, "running");
		await sb.waitForStatus(other, "running");
		expect(sb.job(mine)?.claudeSession).toBe("s1");
		await sb.hook("session-end", { session_id: "s1", reason: "prompt_input_exit" });
		expect((await sb.waitJson(mine)).status).toBe("cancelled");
		expect(sb.jobStatus(other)).toBe("running");
		await sb.cli(["cancel", other]);
	});

	test("by default jobs outlive their session, and session-end never starts a daemon", async () => {
		const r = await sb.hook("session-end", { session_id: "s1", reason: "other" });
		expect(r.code).toBe(0);
		expect(daemonRunning()).toBe(false);
	});

	test("a broken hook input still exits 0", async () => {
		const r = await sb.hook("stop-gate", "not an object");
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("");
	});
});

describe("stop gate", () => {
	const stop = (extra: Record<string, unknown> = {}) =>
		sb.hook("stop-gate", { session_id: "s1", cwd: sb.repo, stop_hook_active: false, ...extra });

	beforeEach(() => {
		sb.commitAll();
	});

	test("off by default", async () => {
		writeFileSync(join(sb.repo, "existing.txt"), "bye\n");
		expect((await stop()).stdout).toBe("");
		expect(daemonRunning()).toBe(false);
	});

	test("blocks on a high finding, once per state of the tree", async () => {
		sb.writeConfig({ stop_gate: { enabled: true, focus: "REVIEW" } });
		writeFileSync(join(sb.repo, "existing.txt"), "bye\n");
		const r = await stop();
		const out = JSON.parse(r.stdout) as { decision: string; reason: string };
		expect(out.decision).toBe("block");
		expect(out.reason).toContain("found 1 issue(s) at high severity or above");
		expect(out.reason).toContain("**[high] Greeting is wrong**");
		expect(out.reason).toMatch(/Full review: omp-task result \d{8}-\d{6}-[0-9a-f]{4}/);
		expect(argModel(sb.ompArgv())).toBe("smol");
		expect((await stop()).stdout).toBe(""); // same diff: not reviewed again
		writeFileSync(join(sb.repo, "existing.txt"), "bye bye\n");
		expect(JSON.parse((await stop()).stdout).decision).toBe("block");
	});

	test("does nothing while a stop hook is already active, or without changes", async () => {
		sb.writeConfig({ stop_gate: { enabled: true, focus: "REVIEW" } });
		expect((await stop()).stdout).toBe("");
		writeFileSync(join(sb.repo, "existing.txt"), "bye\n");
		expect((await stop({ stop_hook_active: true })).stdout).toBe("");
	});

	test("findings below min_severity do not block", async () => {
		sb.writeConfig({ stop_gate: { enabled: true, focus: "REVIEW", min_severity: "critical" } });
		writeFileSync(join(sb.repo, "existing.txt"), "bye\n");
		expect((await stop()).stdout).toBe("");
	});

	test("max_per_session caps the reviews", async () => {
		sb.writeConfig({ stop_gate: { enabled: true, focus: "REVIEW", max_per_session: 1 } });
		writeFileSync(join(sb.repo, "existing.txt"), "bye\n");
		expect((await stop()).stdout).not.toBe("");
		writeFileSync(join(sb.repo, "existing.txt"), "other\n");
		expect((await stop()).stdout).toBe("");
	});
});

function argModel(argv: string[]): string | undefined {
	const i = argv.indexOf("--model");
	return i >= 0 ? argv[i + 1] : undefined;
}

describe("setup", () => {
	test("creates the config from the example and toggles the stop gate", async () => {
		const file = sb.env.OMP_TASK_CONFIG as string;
		const r = await sb.cli(["setup", "--stop-gate", "on"]);
		expect(r.stdout).toContain("created");
		expect(r.stdout).toContain("stop gate:    on (smol)");
		const config = JSON.parse(readFileSync(file, "utf8"));
		expect(config.stop_gate.enabled).toBe(true);
		expect(config.presets.cheap.model).toBe("smol"); // the rest of the example is kept
		await sb.cli(["setup", "--stop-gate", "off"]);
		expect(JSON.parse(readFileSync(file, "utf8")).stop_gate.enabled).toBe(false);
		await sb.cli(["setup", "--stop-gate", "maybe"], [2]);
	});
});

describe("plugin files", () => {
	test("bin/omp-task is executable and runs the CLI", async () => {
		const bin = join(ROOT, "bin/omp-task");
		expect(statSync(bin).mode & 0o111).not.toBe(0);
		const p = Bun.spawnSync([bin, "--version"], { env: sb.env, stdout: "pipe" });
		expect(p.stdout.toString()).toMatch(/^omp-task \d/);
	});

	test("hooks.json calls hooks the CLI knows", () => {
		const hooks = JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8")).hooks;
		const commands = Object.values(hooks).flatMap((entries) =>
			(entries as { hooks: { command: string }[] }[]).flatMap((e) => e.hooks.map((h) => h.command)),
		);
		expect(commands).toHaveLength(3);
		for (const c of commands) {
			expect(c).toMatch(
				/^"\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/omp-task" hook (session-start|session-end|stop-gate)$/,
			);
		}
	});

	test("every command has a description and only calls omp-task", () => {
		for (const f of readdirSync(join(ROOT, "commands"))) {
			const text = readFileSync(join(ROOT, "commands", f), "utf8");
			expect(text).toMatch(/^---\ndescription: .+\n/);
			expect(text).not.toContain("scripts/omp-task");
		}
	});

	test("plugin, marketplace and package versions agree with the CLI", async () => {
		const { VERSION } = await import("../src/version");
		const plugin = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/plugin.json"), "utf8"));
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
		const market = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/marketplace.json"), "utf8"));
		expect(plugin.name).toBe("omp");
		expect(market.plugins[0].name).toBe("omp");
		expect(plugin.version).toBe(VERSION);
		expect(pkg.version).toBe(VERSION);
	});
});
