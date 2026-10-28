import { describe, expect, test } from "bun:test";
import { ChunkAssembler, FrameDecoder, LineSplitter } from "../src/backends/omp-rpc/framing";

const utf8 = (s: string) => new TextEncoder().encode(s);

function chunk(id: string, index: number, count: number, total: number, part: Uint8Array) {
	return {
		type: "rpc_chunk",
		chunkId: id,
		index,
		count,
		byteLength: total,
		data: Buffer.from(part).toString("base64"),
	};
}

describe("LineSplitter", () => {
	test("buffers partial lines across pushes", () => {
		const s = new LineSplitter();
		expect(s.push(utf8('{"a":1}\n{"b"'))).toEqual(['{"a":1}']);
		expect(s.push(utf8(":2}\n"))).toEqual(['{"b":2}']);
		expect(s.flush()).toEqual([]);
	});

	test("keeps multi-byte characters split across pushes intact", () => {
		const s = new LineSplitter();
		const bytes = utf8('"tiếng việt"\n');
		const cut = 5; // inside the multi-byte "ế"
		expect(s.push(bytes.subarray(0, cut))).toEqual([]);
		expect(s.push(bytes.subarray(cut))).toEqual(['"tiếng việt"']);
	});

	test("flush returns a trailing line without newline", () => {
		const s = new LineSplitter();
		s.push(utf8('{"x":1}'));
		expect(s.flush()).toEqual(['{"x":1}']);
	});
});

describe("ChunkAssembler", () => {
	const logical = { type: "agent_end", text: "x".repeat(50) };
	const bytes = utf8(JSON.stringify(logical));
	const half = Math.ceil(bytes.length / 2);
	const parts = [bytes.subarray(0, half), bytes.subarray(half)];

	test("passes plain frames through", () => {
		expect(new ChunkAssembler().push({ type: "ready" })).toEqual({ type: "ready" });
	});

	test("reassembles an in-order sequence", () => {
		const a = new ChunkAssembler();
		expect(a.push(chunk("c1", 0, 2, bytes.length, parts[0] as Uint8Array))).toBeUndefined();
		expect(a.push(chunk("c1", 1, 2, bytes.length, parts[1] as Uint8Array))).toEqual(logical);
	});

	test("rejects interleaved frames and out-of-order chunks", () => {
		const a = new ChunkAssembler();
		a.push(chunk("c1", 0, 2, bytes.length, parts[0] as Uint8Array));
		expect(() => a.push({ type: "message_update" })).toThrow("interrupted");

		const b = new ChunkAssembler();
		expect(() => b.push(chunk("c1", 1, 2, bytes.length, parts[1] as Uint8Array))).toThrow(
			"start at index 0",
		);
	});

	test("rejects a declared length that does not match", () => {
		const a = new ChunkAssembler();
		a.push(chunk("c1", 0, 2, bytes.length + 1, parts[0] as Uint8Array));
		expect(() => a.push(chunk("c1", 1, 2, bytes.length + 1, parts[1] as Uint8Array))).toThrow(
			"length mismatch",
		);
	});
});

describe("FrameDecoder", () => {
	test("decodes chunked and plain frames from one byte stream", () => {
		const logical = { type: "response", command: "get_messages", data: "y".repeat(40) };
		const bytes = utf8(JSON.stringify(logical));
		const lines = [
			JSON.stringify({ type: "ready" }),
			JSON.stringify(chunk("c9", 0, 2, bytes.length, bytes.subarray(0, 10))),
			JSON.stringify(chunk("c9", 1, 2, bytes.length, bytes.subarray(10))),
		].join("\n");
		const d = new FrameDecoder();
		expect(d.push(utf8(`${lines}\n`))).toEqual([{ type: "ready" }, logical]);
	});
});
