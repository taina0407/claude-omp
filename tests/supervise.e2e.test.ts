/** The `supervise` setting: `omp-task mode` and the `next:` lines that tell Claude how to wait. */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { nextSteps, waitTarget } from "../src/cli/main";
import { superviseMode } from "../src/core/config";
import { Sandbox } from "./helpers";

setDefaultTimeout(60_000);

let sb: Sandbox;

beforeEach(() => {
	sb = new Sandbox();
});

afterEach(async () => {
	await sb.dispose();
});

const config = () => sb.env.OMP_TASK_CONFIG as string;

describe("omp-task mode", () => {
	test("shows the default without writing a config", async () => {
		const r = await sb.cli(["mode"]);
		expect(r.stdout).toStartWith("supervise: subagent (default)\n");
		expect(existsSync(config())).toBe(false);
		expect(superviseMode(config())).toBe("subagent");
	});

	test("sets the mode, keeping the rest of the config", async () => {
		sb.writeConfig({ on_session_end: "cancel" });
		const r = await sb.cli(["mode", "bash"]);
		expect(r.stdout).toContain(`supervise: bash (${config()})`);
		expect(r.stdout).toContain("applies to jobs started from now on");
		expect(JSON.parse(readFileSync(config(), "utf8"))).toEqual({
			on_session_end: "cancel",
			supervise: "bash",
		});
		expect((await sb.cli(["mode"])).stdout).toStartWith("supervise: bash");
		await sb.cli(["mode", "subagent"]);
		expect(superviseMode(config())).toBe("subagent");
	});

	test("creates the config when missing; refuses bad values and broken files", async () => {
		await sb.cli(["mode", "bash"]);
		expect(JSON.parse(readFileSync(config(), "utf8"))).toEqual({ supervise: "bash" });
		expect((await sb.cli(["mode", "agent"], [2])).stderr).toContain("subagent or bash");
		writeFileSync(config(), "{ not json");
		await sb.cli(["mode", "subagent"], [2]);
		expect(readFileSync(config(), "utf8")).toBe("{ not json");
		expect(superviseMode(config())).toBe("subagent"); // a broken config falls back
	});

	test("an unknown value in the config is a config error", async () => {
		sb.writeConfig({ supervise: "monitor" });
		expect((await sb.cli(["mode"], [2])).stderr).toContain("supervise");
	});
});

describe("next: lines", () => {
	const job = {
		id: "20261103-170000-ab12",
		title: "fix the [flaky] tests\nin auth",
		model: "smol",
		groupName: null,
	};

	test("subagent mode names the agent, its description and prompt", () => {
		expect(waitTarget(job)).toEqual({
			description: "omp ab12: fix the flaky tests in auth [smol]",
			prompt: "omp-task wait 20261103-170000-ab12",
		});
		const lines = nextSteps("subagent", job).join("\n");
		expect(lines).toContain('subagent_type "omp:job", run_in_background true');
		expect(lines).toContain('description "omp ab12: fix the flaky tests in auth [smol]"');
		expect(lines).toContain("(supervise: subagent)");
		expect(lines).toContain("`omp-task wait 20261103-170000-ab12` as a background Bash command");
	});

	test("bash mode keeps the background wait; groups wait as one", () => {
		expect(nextSteps("bash", job)[0]).toBe(
			"next: run `omp-task wait 20261103-170000-ab12` in the background and end your turn;",
		);
		const grouped = { ...job, groupName: "fan-1" };
		expect(nextSteps("bash", grouped)[0]).toBe(
			"next: once every job of group fan-1 is started, run `omp-task wait --group fan-1` in the background and end your turn;",
		);
		expect(nextSteps("subagent", grouped).join("\n")).toContain(
			'description "omp group fan-1: its jobs", prompt "omp-task wait --group fan-1"',
		);
	});

	test("run --detach prints the configured mode, as text and JSON", async () => {
		const text = (await sb.cli(["run", "--detach", "--title", "t1", "-a", "read", "hello"])).stdout;
		expect(text).toContain('subagent_type "omp:job"');
		const json = JSON.parse(
			(await sb.cli(["run", "--detach", "--json", "--title", "t2", "-a", "read", "hello"])).stdout,
		);
		expect(json.supervise).toBe("subagent");
		expect(json.agent.prompt).toBe(`omp-task wait ${json.id}`);
		expect(json.agent.description).toBe(`omp ${json.id.slice(-4)}: t2 [default]`);

		sb.writeConfig({ supervise: "bash" });
		const bash = (await sb.cli(["run", "--detach", "-a", "read", "hello"])).stdout;
		expect(bash).toContain("in the background and end your turn;");
		expect(bash).not.toContain("omp:job");
		const bashJson = JSON.parse(
			(await sb.cli(["run", "--detach", "--json", "-a", "read", "hello"])).stdout,
		);
		expect(bashJson.supervise).toBe("bash");
		expect(bashJson.agent).toBeUndefined();
	});
});
