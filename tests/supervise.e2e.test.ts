/** The `supervise` setting: `omp-task mode` and the `next:` lines that tell Claude how to wait. */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nextSteps, waitFields, waitTarget } from "../src/cli/main";
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

	test("replaces a wrong supervise value, but no other config error", async () => {
		sb.writeConfig({ supervise: "sub", on_session_end: "keep" });
		expect((await sb.cli(["mode"], [2])).stderr).toContain("supervise");
		expect((await sb.cli(["mode", "subagent"])).stdout).toStartWith("supervise: subagent (");
		expect(JSON.parse(readFileSync(config(), "utf8"))).toEqual({
			supervise: "subagent",
			on_session_end: "keep",
		});
		const broken = JSON.stringify({ supervise: "sub", on_session_end: "later" });
		writeFileSync(config(), broken);
		expect((await sb.cli(["mode", "bash"], [2])).stderr).toContain("on_session_end");
		expect(readFileSync(config(), "utf8")).toBe(broken);
		writeFileSync(config(), "[1]");
		expect((await sb.cli(["mode", "bash"], [2])).stderr).toContain("not a JSON object");
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
		expect(lines).toContain("re-arm it by SendMessage of the same prompt to it");
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

	test("a resumed job re-arms its relay, and starts one only if there is none", () => {
		const lines = nextSteps("subagent", job, { resumed: true });
		expect(lines[0]).toBe(
			"next: re-arm the existing omp:job relay and end your turn (supervise: subagent):",
		);
		expect(lines.join("\n")).toContain(
			'SendMessage to it, message "omp-task wait 20261103-170000-ab12". Only if there is none',
		);
		expect(lines.join("\n")).not.toContain("start the omp:job agent");
		const grouped = nextSteps("subagent", { ...job, groupName: "fan-1" }, { resumed: true });
		expect(grouped[0]).toContain("relay for the whole group");
		expect(grouped.join("\n")).toContain('message "omp-task wait --group fan-1"');
		expect(nextSteps("bash", { ...job, groupName: "fan-1" }, { resumed: true })[0]).toBe(
			"next: run `omp-task wait --group fan-1` in the background and end your turn;",
		);
	});

	test("JSON says whether the wait covers the job or its group", () => {
		expect(waitFields("subagent", job)).toEqual({
			supervise: "subagent",
			wait_scope: "job",
			wait: "omp-task wait 20261103-170000-ab12",
			agent: {
				description: "omp ab12: fix the flaky tests in auth [smol]",
				prompt: "omp-task wait 20261103-170000-ab12",
			},
		});
		expect(waitFields("bash", { ...job, groupName: "fan-1" })).toEqual({
			supervise: "bash",
			wait_scope: "group",
			wait: "omp-task wait --group fan-1",
		});
	});

	test("run -g and plan apply in JSON name the group's one relay", async () => {
		const run = JSON.parse(
			(await sb.cli(["run", "-d", "--json", "-g", "fan-2", "-a", "read", "hello"])).stdout,
		);
		expect(run.wait_scope).toBe("group");
		expect(run.agent).toEqual({
			description: "omp group fan-2: its jobs",
			prompt: "omp-task wait --group fan-2",
		});
		const plan = join(sb.base, "plan.yaml");
		writeFileSync(
			plan,
			"group: fan-3\ndefaults: { access: read }\ntasks:\n  - {name: a, prompt: hello}\n",
		);
		const applied = JSON.parse((await sb.cli(["plan", "apply", plan, "--json"])).stdout);
		expect(applied.group).toBe("fan-3");
		expect(applied.supervise).toBe("subagent");
		expect(applied.wait_scope).toBe("group");
		expect(applied.agent.prompt).toBe("omp-task wait --group fan-3");
		writeFileSync(
			plan,
			"group: fan-4\ndefaults: { access: read }\ntasks:\n  - {name: a, prompt: hello}\n",
		);
		const text = (await sb.cli(["plan", "apply", plan])).stdout;
		expect(text).toContain("next: start the omp:job agent for the whole group");
		for (const g of ["fan-2", "fan-3", "fan-4"]) await sb.cli(["wait", "--group", g]);
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
