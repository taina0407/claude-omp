/**
 * Transport framing for `omp --mode rpc`: newline-delimited JSON on stdio, plus the
 * protocol-v2 `rpc_chunk` frames omp uses for logical frames larger than one line allows.
 */

/** omp's limit for one physical JSONL line, newline included (MAX_RPC_FRAME_BYTES). */
export const MAX_LINE_BYTES = 1024 * 1024;
/** omp's limit for a logical frame reassembled from chunks (MAX_RPC_REASSEMBLED_BYTES). */
export const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

export type Frame = Record<string, unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Splits a byte stream into complete UTF-8 lines; keeps the trailing partial line buffered. */
export class LineSplitter {
	#buffer = "";
	readonly #decoder = new TextDecoder("utf-8");

	push(bytes: Uint8Array): string[] {
		this.#buffer += this.#decoder.decode(bytes, { stream: true });
		const lines = this.#buffer.split("\n");
		this.#buffer = lines.pop() ?? "";
		return lines.filter((line) => line.length > 0);
	}

	/** Returns whatever is left once the stream has ended. */
	flush(): string[] {
		const rest = this.#buffer + this.#decoder.decode();
		this.#buffer = "";
		return rest.length > 0 ? [rest] : [];
	}
}

interface PendingChunks {
	chunkId: string;
	count: number;
	byteLength: number;
	nextIndex: number;
	parts: Uint8Array[];
	received: number;
}

/**
 * Reassembles protocol-v2 chunk sequences. Mirrors omp's own RpcFrameDecoder: chunks of one
 * logical frame arrive contiguously, in order, and nothing else may interleave with them.
 */
export class ChunkAssembler {
	#pending: PendingChunks | undefined;

	/** Returns the logical frame, or undefined while a chunk sequence is still incomplete. */
	push(value: unknown): Frame | undefined {
		if (!isRecord(value)) throw new Error("rpc frame must be an object");
		if (value.type !== "rpc_chunk") {
			if (this.#pending) throw new Error("rpc chunk sequence interrupted");
			return value;
		}
		const { chunkId, index, count, byteLength, data } = value;
		if (
			typeof chunkId !== "string" ||
			typeof index !== "number" ||
			typeof count !== "number" ||
			typeof byteLength !== "number" ||
			typeof data !== "string" ||
			!Number.isSafeInteger(index) ||
			!Number.isSafeInteger(count) ||
			index < 0 ||
			count < 2 ||
			index >= count ||
			byteLength > MAX_REASSEMBLED_BYTES
		) {
			throw new Error("invalid rpc chunk metadata");
		}
		if (!this.#pending) {
			if (index !== 0) throw new Error("rpc chunk sequence must start at index 0");
			this.#pending = { chunkId, count, byteLength, nextIndex: 0, parts: [], received: 0 };
		}
		const pending = this.#pending;
		if (
			pending.chunkId !== chunkId ||
			pending.count !== count ||
			pending.byteLength !== byteLength ||
			pending.nextIndex !== index
		) {
			throw new Error("rpc chunk sequence mismatch");
		}
		const bytes = Buffer.from(data, "base64");
		pending.parts.push(bytes);
		pending.received += bytes.byteLength;
		pending.nextIndex++;
		if (pending.received > pending.byteLength) {
			throw new Error("rpc chunk sequence exceeds declared length");
		}
		if (pending.nextIndex < pending.count) return undefined;
		this.#pending = undefined;
		if (pending.received !== pending.byteLength) throw new Error("rpc chunk length mismatch");
		const json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.parts));
		const frame: unknown = JSON.parse(json);
		if (!isRecord(frame)) throw new Error("rpc frame must be an object");
		return frame;
	}
}

/** Line splitting, JSON parsing and chunk reassembly in one step. */
export class FrameDecoder {
	readonly #lines = new LineSplitter();
	readonly #chunks = new ChunkAssembler();

	push(bytes: Uint8Array): Frame[] {
		return this.#decode(this.#lines.push(bytes));
	}

	flush(): Frame[] {
		return this.#decode(this.#lines.flush());
	}

	#decode(lines: string[]): Frame[] {
		const frames: Frame[] = [];
		for (const line of lines) {
			const frame = this.#chunks.push(JSON.parse(line));
			if (frame) frames.push(frame);
		}
		return frames;
	}
}

export function encodeFrame(frame: Frame): string {
	return `${JSON.stringify(frame)}\n`;
}

const CHUNK_PAYLOAD_BYTES = 256 * 1024;

/**
 * Encodes one logical frame as JSONL lines: a single line when it fits, otherwise a protocol-v2
 * `rpc_chunk` sequence. Only valid after `negotiate_protocol` succeeded with version 2.
 */
export function encodeFrameV2(frame: Frame, chunkId: string): string[] {
	const line = encodeFrame(frame);
	const bytes = Buffer.from(line.slice(0, -1), "utf8");
	if (bytes.byteLength + 1 <= MAX_LINE_BYTES) return [line];
	const count = Math.ceil(bytes.byteLength / CHUNK_PAYLOAD_BYTES);
	const lines: string[] = [];
	for (let index = 0; index < count; index++) {
		const part = bytes.subarray(index * CHUNK_PAYLOAD_BYTES, (index + 1) * CHUNK_PAYLOAD_BYTES);
		lines.push(
			encodeFrame({
				type: "rpc_chunk",
				chunkId,
				index,
				count,
				byteLength: bytes.byteLength,
				data: part.toString("base64"),
			}),
		);
	}
	return lines;
}
