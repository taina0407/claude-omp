/** Runs `omp --mode rpc` as a child process and connects it to an OmpRpcProtocol. */
import { appendFileSync, closeSync, openSync, readFileSync } from "node:fs";
import type { Subprocess } from "bun";
import { ompBin } from "../../core/paths";
import { errorText } from "../../core/util";
import type { Backend, BackendEvent, BackendSession, EventLogMode, SessionSpec } from "../types";
import { buildArgs } from "./args";
import { compactFrame, encodeFrame, type Frame, FrameDecoder } from "./framing";
import { OmpRpcProtocol } from "./protocol";

/** omp can take a while before it acknowledges a prompt (25s per turn where D-Bus is missing). */
const STARTUP_TIMEOUT_MS = 120_000;
/** How long `close()` waits for omp to exit after stdin is closed, before signalling it. */
const EXIT_GRACE_MS = 5_000;

function tail(path: string, chars = 800): string {
	try {
		return readFileSync(path, "utf8").slice(-chars).trim();
	} catch {
		return "";
	}
}

class OmpRpcSession implements BackendSession {
	readonly #proc: Subprocess<"pipe", "pipe", number> | null;
	readonly #protocol: OmpRpcProtocol;
	readonly #rawLogPath: string;
	readonly #eventLog: EventLogMode;
	#exited: Promise<void> = Promise.resolve();
	#timers: ReturnType<typeof setTimeout>[] = [];
	#ended = false;

	constructor(spec: SessionSpec, onEvent: (e: BackendEvent) => void) {
		this.#rawLogPath = spec.rawLogPath;
		this.#eventLog = spec.eventLog ?? "compact";
		const emit = (e: BackendEvent) => {
			if (e.kind === "end") {
				if (this.#ended) return;
				this.#ended = true;
				for (const t of this.#timers) clearTimeout(t);
			}
			onEvent(e);
		};
		this.#protocol = new OmpRpcProtocol({
			prompt: spec.prompt,
			extraTools: spec.hostTools ?? [],
			send: (f) => this.#send(f),
			emit,
		});

		const bin = ompBin();
		if (!bin) {
			this.#proc = null;
			queueMicrotask(() =>
				this.#protocol.onExit(null, "omp not found on PATH (install omp or set OMP_TASK_OMP_BIN)"),
			);
			return;
		}
		const argv = [bin, ...buildArgs(spec)];
		const stderrFd = openSync(spec.stderrPath, "a");
		try {
			this.#proc = Bun.spawn(argv, {
				cwd: spec.cwd,
				...(spec.env ? { env: spec.env } : {}),
				stdin: "pipe",
				stdout: "pipe",
				stderr: stderrFd,
			});
		} catch (e) {
			closeSync(stderrFd);
			this.#proc = null;
			queueMicrotask(() => this.#protocol.onExit(null, `cannot start omp: ${errorText(e)}`));
			return;
		}
		closeSync(stderrFd);
		const proc = this.#proc;
		emit({ kind: "spawned", pid: proc.pid, argv });

		this.#timers.push(
			setTimeout(() => {
				if (this.#protocol.phase !== "running" && this.#protocol.phase !== "ended") {
					emit({ kind: "warning", text: "omp did not accept the prompt in time" });
					this.#protocol.onExit(null, `omp did not start within ${STARTUP_TIMEOUT_MS / 1000}s`);
					proc.kill("SIGTERM");
				}
			}, STARTUP_TIMEOUT_MS),
		);

		const reader = this.#read(proc, emit);
		const protocol = this.#protocol;
		this.#exited = (async () => {
			const code = await proc.exited;
			await reader;
			protocol.onExit(code, tail(spec.stderrPath));
		})();
	}

	async #read(proc: Subprocess<"pipe", "pipe", number>, emit: (e: BackendEvent) => void) {
		const decoder = new FrameDecoder();
		const handle = (frames: Frame[]) => {
			for (const frame of frames) {
				if (this.#eventLog !== "off") {
					const logged = this.#eventLog === "full" ? frame : compactFrame(frame);
					appendFileSync(this.#rawLogPath, encodeFrame(logged));
				}
				this.#protocol.onFrame(frame);
			}
		};
		try {
			for await (const bytes of proc.stdout) handle(decoder.push(bytes));
			handle(decoder.flush());
		} catch (e) {
			emit({ kind: "warning", text: `cannot decode omp output: ${errorText(e)}` });
		}
	}

	#send(frame: Frame): void {
		const proc = this.#proc;
		if (!proc || proc.exitCode !== null) return;
		try {
			proc.stdin.write(encodeFrame(frame));
			proc.stdin.flush();
		} catch {
			// omp is gone; its exit is reported through `exited`.
		}
	}

	steer(text: string): void {
		this.#protocol.steer(text);
	}

	abort(): void {
		this.#protocol.abort();
	}

	answer(ref: string, text: string, isError = false): void {
		this.#protocol.answer(ref, text, isError);
	}

	decide(ref: string, decision: "approve" | "session" | "deny"): void {
		this.#protocol.decide(ref, decision);
	}

	async close(): Promise<void> {
		for (const t of this.#timers) clearTimeout(t);
		const proc = this.#proc;
		if (!proc) return;
		if (proc.exitCode === null) {
			try {
				proc.stdin.end();
			} catch {
				// already closed
			}
			const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(EXIT_GRACE_MS)]);
			if (exited !== true) {
				proc.kill("SIGTERM");
				const gone = await Promise.race([proc.exited.then(() => true), Bun.sleep(EXIT_GRACE_MS)]);
				if (gone !== true) proc.kill("SIGKILL");
			}
		}
		await this.#exited;
	}
}

export const ompRpcBackend: Backend = {
	id: "omp-rpc",
	start(spec, onEvent) {
		return new OmpRpcSession(spec, onEvent);
	},
};
