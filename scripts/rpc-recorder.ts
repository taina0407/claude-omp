/**
 * Drives a real `omp --mode rpc` process through one scenario and records every frame in both
 * directions. Used by the M0 spike to capture fixtures for the omp-rpc backend.
 */
import type { Subprocess } from "bun";
import {
	ChunkAssembler,
	encodeFrame,
	encodeFrameV2,
	type Frame,
	isRecord,
	LineSplitter,
} from "../src/backends/omp-rpc/framing";

export type Direction = "in" | "out";

export interface RecordedLine {
	/** Milliseconds since the process was spawned. */
	t: number;
	/** "in" = omp → host, "out" = host → omp. */
	dir: Direction;
	frame: Frame;
	/** Set on a logical frame that was reassembled from protocol-v2 chunks. */
	chunks?: number;
}

export interface ScenarioContext {
	send(frame: Frame): void;
	/** Sends a frame as protocol-v2 chunks when it is larger than one line allows. */
	sendChunked(frame: Frame): void;
	/** Sends a command with a fresh id and resolves with its `response` frame. */
	command(type: string, fields?: Frame, timeoutMs?: number): Promise<Frame>;
	/** Resolves with the next frame (including ones already buffered) that matches. */
	waitFor(match: (f: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
	/** Waits for the end of the agent run: an `agent_end` that will not continue. */
	waitForAgentEnd(timeoutMs?: number): Promise<Frame>;
	note(text: string): void;
	readonly frames: readonly RecordedLine[];
	readonly vars: Record<string, string>;
}

export interface Scenario {
	name: string;
	description: string;
	/** Extra omp flags, appended after the base flags (`--mode rpc --no-title --cwd …`). */
	args(vars: Record<string, string>): string[];
	/** Replaces the default `--mode rpc --no-title`, e.g. to record a `--no-ui` variant. */
	baseArgs?: string[];
	run(ctx: ScenarioContext): Promise<void>;
	/** Auto-handler for frames that need an answer (host tool calls, approval prompts). */
	onFrame?(frame: Frame, ctx: ScenarioContext): void;
	/** Values to keep for later scenarios, e.g. a session id to resume. */
	exports?(ctx: ScenarioContext): Record<string, string>;
}

export interface RecordOptions {
	ompBin: string;
	workdir: string;
	sessionDir: string;
	vars: Record<string, string>;
	timeoutMs: number;
}

export interface RecordResult {
	lines: RecordedLine[];
	notes: string[];
	stderr: string;
	exitCode: number | null;
	error?: string;
	exports: Record<string, string>;
	argv: string[];
}

export function isAgentEnd(f: Frame): boolean {
	return f.type === "agent_end" && f.isTerminal !== false && f.willContinue !== true;
}

export async function record(scenario: Scenario, opts: RecordOptions): Promise<RecordResult> {
	const argv = [
		opts.ompBin,
		...(scenario.baseArgs ?? ["--mode", "rpc", "--no-title"]),
		"--cwd",
		opts.workdir,
		"--session-dir",
		opts.sessionDir,
		...scenario.args(opts.vars),
	];
	const started = performance.now();
	const lines: RecordedLine[] = [];
	const notes: string[] = [];
	const waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
	const claimed = new Set<number>(); // indexes of frames already handed to a waitFor
	let nextId = 0;

	const proc: Subprocess<"pipe", "pipe", "pipe"> = Bun.spawn(argv, {
		cwd: opts.workdir,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const now = () => Math.round(performance.now() - started);

	const ctx: ScenarioContext = {
		frames: lines,
		vars: opts.vars,
		send(frame) {
			lines.push({ t: now(), dir: "out", frame });
			proc.stdin.write(encodeFrame(frame));
			proc.stdin.flush();
		},
		sendChunked(frame) {
			const physical = encodeFrameV2(frame, `host-${++nextId}`);
			const line: RecordedLine = { t: now(), dir: "out", frame };
			if (physical.length > 1) line.chunks = physical.length;
			lines.push(line);
			for (const l of physical) proc.stdin.write(l);
			proc.stdin.flush();
		},
		async command(type, fields = {}, timeoutMs = 60_000) {
			const id = `rec-${++nextId}`;
			const reply = ctx.waitFor((f) => f.type === "response" && f.id === id, timeoutMs);
			ctx.send({ id, type, ...fields });
			return reply;
		},
		waitFor(match, timeoutMs = opts.timeoutMs) {
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (line?.dir === "in" && !claimed.has(i) && match(line.frame)) {
					claimed.add(i);
					return Promise.resolve(line.frame);
				}
			}
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					const i = waiters.indexOf(waiter);
					if (i >= 0) waiters.splice(i, 1);
					reject(new Error(`timed out after ${timeoutMs}ms waiting for a frame`));
				}, timeoutMs);
				const waiter = {
					match,
					resolve: (f: Frame) => {
						clearTimeout(timer);
						resolve(f);
					},
				};
				waiters.push(waiter);
			});
		},
		waitForAgentEnd(timeoutMs) {
			return ctx.waitFor(isAgentEnd, timeoutMs);
		},
		note(text) {
			notes.push(text);
		},
	};

	const onIncoming = (frame: Frame, chunks?: number) => {
		const line: RecordedLine = { t: now(), dir: "in", frame };
		if (chunks) line.chunks = chunks;
		lines.push(line);
		scenario.onFrame?.(frame, ctx);
		for (let i = 0; i < waiters.length; i++) {
			const w = waiters[i];
			if (w?.match(frame)) {
				waiters.splice(i, 1);
				claimed.add(lines.length - 1);
				w.resolve(frame);
				break;
			}
		}
	};

	const reader = (async () => {
		const splitter = new LineSplitter();
		const assembler = new ChunkAssembler();
		let chunkLines = 0;
		const decode = (raw: string[]) => {
			for (const text of raw) {
				const parsed: unknown = JSON.parse(text);
				if (isRecord(parsed) && parsed.type === "rpc_chunk") chunkLines++;
				const frame = assembler.push(parsed);
				if (!frame) continue;
				onIncoming(frame, chunkLines || undefined);
				chunkLines = 0;
			}
		};
		for await (const bytes of proc.stdout) decode(splitter.push(bytes));
		decode(splitter.flush());
	})();
	const stderrText = new Response(proc.stderr).text();

	let error: string | undefined;
	try {
		await ctx.waitFor((f) => f.type === "ready", 30_000);
		await withTimeout(scenario.run(ctx), opts.timeoutMs, scenario.name);
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}
	const exports = error ? {} : (scenario.exports?.(ctx) ?? {});

	proc.stdin.end();
	const exited = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => null)]);
	if (exited === null) {
		proc.kill("SIGTERM");
		notes.push("omp did not exit within 5s of stdin closing; sent SIGTERM");
		await Promise.race([proc.exited, Bun.sleep(5_000)]);
	}
	await reader.catch((e) => {
		error ??= `stdout decode failed: ${e instanceof Error ? e.message : String(e)}`;
	});
	const result: RecordResult = {
		lines,
		notes,
		stderr: await stderrText,
		exitCode: proc.exitCode,
		exports,
		argv,
	};
	if (error) result.error = error;
	return result;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`scenario ${label} exceeded ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** Replaces machine-specific strings everywhere in a JSON value. */
export function anonymize(value: unknown, replacements: ReadonlyArray<[string, string]>): unknown {
	if (typeof value === "string") {
		let out = value;
		for (const [from, to] of replacements) if (from) out = out.split(from).join(to);
		return out;
	}
	if (Array.isArray(value)) return value.map((v) => anonymize(v, replacements));
	if (isRecord(value)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = anonymize(v, replacements);
		return out;
	}
	return value;
}

/** Shortens long strings so a fixture stays reviewable; keeps the length for reference. */
export function truncateStrings(value: unknown, max: number): unknown {
	if (typeof value === "string") {
		return value.length > max ? `${value.slice(0, max)}…[+${value.length - max} chars]` : value;
	}
	if (Array.isArray(value)) return value.map((v) => truncateStrings(v, max));
	if (isRecord(value)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = truncateStrings(v, max);
		return out;
	}
	return value;
}

/** Arrays longer than this keep their first items plus a marker, in fixtures only. */
const FIXTURE_ARRAY_LIMIT = 20;

/**
 * Shrinks a frame for a committed fixture without hiding its shape: streaming updates drop the
 * partial message they repeat (the delta stays), and long arrays are cut.
 */
export function compactForFixture(frame: unknown): unknown {
	if (isRecord(frame) && frame.type === "subagent_event" && isRecord(frame.payload)) {
		return {
			...frame,
			payload: { ...frame.payload, event: compactForFixture(frame.payload.event) },
		};
	}
	if (isRecord(frame) && frame.type === "message_update") {
		const out: Record<string, unknown> = { ...frame, message: "<partial message elided>" };
		const ev = frame.assistantMessageEvent;
		if (isRecord(ev) && "partial" in ev) {
			out.assistantMessageEvent = { ...ev, partial: "<partial message elided>" };
		}
		return out;
	}
	return cutArrays(frame);
}

function cutArrays(value: unknown): unknown {
	if (Array.isArray(value)) {
		const kept = value.slice(0, FIXTURE_ARRAY_LIMIT).map(cutArrays);
		if (value.length > FIXTURE_ARRAY_LIMIT)
			kept.push(`…[${value.length - FIXTURE_ARRAY_LIMIT} more items elided]`);
		return kept;
	}
	if (isRecord(value)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = cutArrays(v);
		return out;
	}
	return value;
}
