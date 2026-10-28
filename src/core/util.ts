/** Small helpers shared across the CLI and the runner. */

export class UsageError extends Error {}

/** '90', '20m', '1h', '1h30m', 90 → seconds. Empty, 0 and null mean "no limit". */
export function parseDuration(value: string | number | null | undefined): number | null {
	if (value === null || value === undefined || value === "" || value === 0 || value === "0") {
		return null;
	}
	if (typeof value === "number") return value;
	const units: Record<string, number> = { h: 3600, m: 60, s: 1, "": 1 };
	let total = 0;
	let matched = false;
	for (const m of value.matchAll(/(\d+(?:\.\d+)?)\s*([hms]?)/g)) {
		matched = true;
		total += Number(m[1]) * (units[m[2] ?? ""] ?? 1);
	}
	if (!matched) throw new UsageError(`bad duration: '${value}'`);
	return total;
}

export function nowIso(): string {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** Job ids sort by creation time: YYYYMMDD-HHMMSS-xxxx (local time), like v0.2. */
export function newJobId(now = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
	const rand = crypto.getRandomValues(new Uint8Array(2));
	return `${stamp}-${Buffer.from(rand).toString("hex")}`;
}

/** First meaningful line of a brief, without markdown markers, for job titles. */
export function firstLine(text: string): string {
	for (const raw of text.split("\n")) {
		const line = raw.replace(/^[#>*\-\s]+/, "").trim();
		if (line) return line.slice(0, 80);
	}
	return "(untitled)";
}

/** Splits a shell-quoted string into words (single and double quotes, backslash escapes). */
export function shellSplit(input: string): string[] {
	const words: string[] = [];
	let current = "";
	let inWord = false;
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < input.length; i++) {
		const c = input[i] as string;
		if (quote) {
			if (c === quote) quote = null;
			else if (c === "\\" && quote === '"' && i + 1 < input.length) current += input[++i];
			else current += c;
		} else if (c === "'" || c === '"') {
			quote = c;
			inWord = true;
		} else if (c === "\\" && i + 1 < input.length) {
			current += input[++i];
			inWord = true;
		} else if (/\s/.test(c)) {
			if (inWord) words.push(current);
			current = "";
			inWord = false;
		} else {
			current += c;
			inWord = true;
		}
	}
	if (quote) throw new UsageError(`unterminated quote in: ${input}`);
	if (inWord) words.push(current);
	return words;
}

export function pidAlive(pid: number | null | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
