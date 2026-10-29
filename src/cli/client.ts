/**
 * The CLI's connection to the daemon: HTTP over the daemon's unix socket. `connect()` starts the
 * daemon when none is running and restarts an idle one that runs a different version.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { FeedEvent, Health } from "../api/schema";
import { detachedEnv } from "../core/env";
import { cliCommand, socketPath, stateDir } from "../core/paths";
import { UsageError } from "../core/util";
import { VERSION } from "../version";

/** The daemon could not be reached or started (exit code 5). */
export class DaemonError extends Error {}

const START_TIMEOUT_MS = 10_000;

export class Client {
	constructor(readonly socket: string) {}

	async #fetch(method: string, path: string, body?: unknown): Promise<Response> {
		const init: RequestInit & { unix: string } = { method, unix: this.socket };
		if (body !== undefined) {
			init.body = JSON.stringify(body);
			init.headers = { "content-type": "application/json" };
		}
		try {
			return await fetch(`http://omp-task${path}`, init);
		} catch (e) {
			throw new DaemonError(`cannot reach the omp-task daemon: ${(e as Error).message}`);
		}
	}

	/** Calls the API; 4xx answers become usage errors (exit 2) with the daemon's message. */
	async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await this.#fetch(method, path, body);
		const data = (await res.json().catch(() => ({}))) as { error?: string };
		if (res.status >= 400 && res.status < 500)
			throw new UsageError(data.error ?? `HTTP ${res.status}`);
		if (!res.ok) throw new DaemonError(data.error ?? `daemon answered HTTP ${res.status}`);
		return data as T;
	}

	async health(): Promise<Health | null> {
		try {
			const res = await fetch("http://omp-task/v1/health", { unix: this.socket });
			return res.ok ? ((await res.json()) as Health) : null;
		} catch {
			return null;
		}
	}

	/**
	 * Streams GET /v1/feed (server-sent events) until the daemon sends `end`: once the jobs ended,
	 * or right after the events so far when `follow` is false.
	 */
	async *feed(ids: string[], fromStart: boolean, follow = true): AsyncGenerator<FeedEvent> {
		const q = new URLSearchParams({
			ids: ids.join(","),
			from: fromStart ? "start" : "latest",
			follow: follow ? "1" : "0",
		});
		const res = await this.#fetch("GET", `/v1/feed?${q}`);
		if (!res.ok || !res.body) {
			const data = (await res.json().catch(() => ({}))) as { error?: string };
			throw new UsageError(data.error ?? `HTTP ${res.status}`);
		}
		const decoder = new TextDecoder();
		let buf = "";
		for await (const chunk of res.body) {
			buf += decoder.decode(chunk, { stream: true });
			let end = buf.indexOf("\n\n");
			while (end >= 0) {
				const block = buf.slice(0, end);
				buf = buf.slice(end + 2);
				const data = block
					.split("\n")
					.filter((l) => l.startsWith("data: "))
					.map((l) => l.slice(6))
					.join("\n");
				if (data) yield JSON.parse(data) as FeedEvent;
				end = buf.indexOf("\n\n");
			}
		}
	}
}

/** The daemon for this state dir, if one is running; never starts one. */
export async function existingDaemon(): Promise<{ client: Client; health: Health } | null> {
	const client = new Client(socketPath());
	const health = await client.health();
	return health ? { client, health } : null;
}

function spawnDaemon(): void {
	mkdirSync(stateDir(), { recursive: true });
	const out = openSync(join(stateDir(), "daemon.out"), "a");
	const [bin, ...args] = cliCommand() as [string, ...string[]];
	const child = spawn(bin, [...args, "daemon"], {
		detached: true,
		stdio: ["ignore", out, out],
		// The daemon outlives this session and serves every other one: it must not carry its identity.
		env: detachedEnv(process.env),
	});
	closeSync(out);
	child.unref();
}

async function waitForHealth(client: Client, ms: number): Promise<Health | null> {
	const deadline = performance.now() + ms;
	while (performance.now() < deadline) {
		const h = await client.health();
		if (h) return h;
		await Bun.sleep(50);
	}
	return null;
}

/** Whether version `a` (x.y.z, any suffix ignored) is newer than `b`. */
export function newerVersion(a: string, b: string): boolean {
	const parts = (v: string) => v.split(/[-+]/)[0]?.split(".").map(Number) ?? [];
	const [x, y] = [parts(a), parts(b)];
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d) return d > 0;
	}
	return false;
}

/** Connects to the daemon, starting it (or replacing an idle one of another version) if needed. */
export async function connect(): Promise<Client> {
	const client = new Client(socketPath());
	let health = await client.health();
	if (health && newerVersion(health.version, VERSION)) {
		// Replacing it would run an older daemon on a database a newer build may have upgraded.
		throw new DaemonError(
			`the omp-task daemon runs ${health.version}, newer than this CLI (${VERSION}); ` +
				"update the plugin (in Claude Code: /reload-plugins) or use the newer omp-task",
		);
	}
	if (health && health.version !== VERSION) {
		if (health.activeJobs === 0) {
			await client.call("POST", "/v1/shutdown", {}).catch(() => {});
			const deadline = performance.now() + 5_000;
			while ((await client.health()) && performance.now() < deadline) await Bun.sleep(50);
			health = null;
		} else {
			process.stderr.write(
				`omp-task: the daemon runs ${health.version} (this CLI is ${VERSION}); it restarts once its ${health.activeJobs} job(s) end\n`,
			);
		}
	}
	if (!health) {
		spawnDaemon();
		if (!(await waitForHealth(client, START_TIMEOUT_MS))) {
			throw new DaemonError(
				`the omp-task daemon did not start; see ${join(stateDir(), "daemon.out")} and daemon.log`,
			);
		}
	}
	return client;
}
