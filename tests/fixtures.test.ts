import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Invariants of the recorded omp RPC fixtures (scripts/record-rpc.ts). The omp-rpc backend in
 * M1 is built against these, so a re-recording that breaks one is a protocol change to look at.
 */
const dir = join(import.meta.dir, "fixtures/rpc");
const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));

interface Line {
	t: number;
	dir: "in" | "out";
	frame: Record<string, unknown>;
	chunks?: number;
}

function load(file: string) {
	const [head, ...rest] = readFileSync(join(dir, file), "utf8").trim().split("\n");
	return {
		header: JSON.parse(head ?? "{}") as Record<string, unknown>,
		lines: rest.map((l) => JSON.parse(l) as Line),
	};
}

test("fixtures exist", () => {
	expect(files.length).toBeGreaterThan(0);
});

describe.each(files)("%s", (file) => {
	const { header, lines } = load(file);

	test("header describes a clean recording", () => {
		expect(header.fixture).toBe(file.replace(/\.jsonl$/, ""));
		expect(String(header.ompVersion)).toMatch(/^omp\/\d+\./);
		expect(header.error).toBeNull();
		expect(header.frameCount).toBe(lines.length);
	});

	test("starts with a protocol-v1 ready frame advertising v2", () => {
		const ready = lines[0]?.frame;
		expect(ready?.type).toBe("ready");
		expect(ready?.protocolVersion).toBe(1);
		expect(ready?.supportedProtocolVersions).toEqual([1, 2]);
	});

	test("timestamps never go backwards", () => {
		for (let i = 1; i < lines.length; i++) {
			expect((lines[i] as Line).t).toBeGreaterThanOrEqual((lines[i - 1] as Line).t);
		}
	});

	test("every host command with an id gets exactly one response", () => {
		const responses = lines.filter((l) => l.dir === "in" && l.frame.type === "response");
		for (const out of lines.filter((l) => l.dir === "out" && typeof l.frame.id === "string")) {
			if (out.chunks) continue; // chunked input is rejected chunk by chunk, see v2-chunking
			if (out.frame.type === "host_tool_result" || out.frame.type === "extension_ui_response")
				continue;
			const matches = responses.filter((r) => r.frame.id === out.frame.id);
			expect(matches.length, `response to ${String(out.frame.type)} ${String(out.frame.id)}`).toBe(
				1,
			);
		}
	});

	test("every prompt that ran ends with agent_end, then prompt_result", () => {
		const prompts = lines.filter((l) => l.dir === "out" && l.frame.type === "prompt");
		const ends = lines.filter((l) => l.frame.type === "agent_end" && l.frame.isTerminal !== false);
		const results = lines.filter((l) => l.frame.type === "prompt_result");
		expect(ends.length).toBe(prompts.length);
		expect(results.length).toBe(prompts.length);
		for (const r of results) expect(r.frame.agentInvoked).toBe(true);
	});

	test("every host tool call is answered", () => {
		const calls = lines.filter((l) => l.frame.type === "host_tool_call");
		for (const c of calls) {
			const answered = lines.some(
				(l) => l.dir === "out" && l.frame.type === "host_tool_result" && l.frame.id === c.frame.id,
			);
			expect(answered, `host_tool_call ${String(c.frame.id)}`).toBe(true);
		}
	});
});
