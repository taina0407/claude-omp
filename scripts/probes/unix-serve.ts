#!/usr/bin/env bun
/**
 * M0 probe: can the daemon serve HTTP + SSE over a unix socket with Bun alone, and can a client
 * talk to it with plain fetch? Prints a JSON report; exits non-zero on any failure.
 */
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "omp-unix-"));
chmodSync(dir, 0o700);
const socket = join(dir, "daemon.sock");
const report: Record<string, unknown> = { bun: Bun.version };

const server = Bun.serve({
	unix: socket,
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/v1/health") return Response.json({ ok: true, pid: process.pid });
		if (url.pathname === "/v1/events") {
			let n = 0;
			const stream = new ReadableStream({
				async pull(ctrl) {
					if (n >= 3) return ctrl.close();
					ctrl.enqueue(`event: feed\ndata: ${JSON.stringify({ seq: ++n })}\n\n`);
					await Bun.sleep(20);
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		}
		return new Response("not found", { status: 404 });
	},
});

try {
	report.socketMode = (statSync(socket).mode & 0o777).toString(8);
	const t0 = performance.now();
	const health = (await fetch("http://localhost/v1/health", { unix: socket }).then((r) =>
		r.json(),
	)) as { ok?: boolean };
	report.healthMs = Math.round((performance.now() - t0) * 10) / 10;
	report.health = health;

	const res = await fetch("http://localhost/v1/events", { unix: socket });
	const text = await res.text();
	report.sseEvents = text.split("\n\n").filter(Boolean).length;
	report.sseContentType = res.headers.get("content-type");

	// A second server on the same path must fail: that is what stops two daemons from starting.
	try {
		Bun.serve({ unix: socket, fetch: () => new Response("dup") }).stop(true);
		report.secondBindRejected = false;
	} catch (e) {
		report.secondBindRejected = true;
		report.secondBindError = e instanceof Error ? e.message : String(e);
	}
	report.ok = report.sseEvents === 3 && health.ok === true;
} finally {
	server.stop(true);
	report.socketRemovedOnStop = !(await Bun.file(socket).exists());
	rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
