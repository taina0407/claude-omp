/**
 * Approval rules: globs the daemon applies to a worker's approval request so routine commands
 * (`bun test*`) do not wake the orchestrator. A rule matches the command text (omp's
 * "Command: ..." line), or the whole tool when written `tool:<name>`. `*` matches any text and
 * `?` one character; the match is anchored at both ends.
 *
 * Deny rules win. A command list joined with `&&`, `||` or `;` is split, outside quotes, into its
 * commands: an allow rule approves it only when every command matches one, and a deny rule that
 * matches any command denies it. Pipes, background `&`, redirects, backticks, `$(` and newlines
 * are never approved by a command rule, so `bun test*` cannot approve `bun test | sh`. The bash
 * no-op commands `true` and `:` need no rule.
 */
import type { ApprovalDecision } from "./types";

/** Never approved by a command rule, quoted or not. */
const UNSAFE = /[`<>\n]|\$\(/;
/** Commands that do nothing, approved without a rule so a worker's `true` does not wake anyone. */
const NO_OPS: ReadonlySet<string> = new Set(["true", ":"]);
export const NO_OP_RULE = "builtin:no-op";

function globRegex(glob: string): RegExp {
	const body = glob
		.split("")
		.map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
		.join("");
	return new RegExp(`^${body}$`, "s");
}

/** The command text of an approval detail ("Command: make test" → "make test"). */
export function approvalSubject(detail: string): string {
	return detail.replace(/^[A-Za-z ]+:\s*/, "").trim();
}

/**
 * The commands of a list joined with `&&`, `||` or `;`, split outside quotes, or null when it
 * holds anything else a shell would treat specially there (a pipe, `&`, an unclosed quote) or an
 * empty command.
 */
export function splitCommands(command: string): string[] | null {
	const parts: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < command.length; i++) {
		const c = command[i] as string;
		if (quote) {
			if (c === "\\" && quote === '"') {
				current += c + (command[++i] ?? "");
				continue;
			}
			if (c === quote) quote = null;
			current += c;
			continue;
		}
		if (c === "\\") {
			current += c + (command[++i] ?? "");
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			current += c;
			continue;
		}
		const pair = command.slice(i, i + 2);
		if (c === ";" || pair === "&&" || pair === "||") {
			parts.push(current.trim());
			current = "";
			if (c !== ";") i++;
			continue;
		}
		if (c === "|" || c === "&") return null;
		current += c;
	}
	if (quote) return null;
	parts.push(current.trim());
	return parts.every(Boolean) ? parts : null;
}

function matches(rule: string, tool: string, subject: string): boolean {
	const r = rule.trim();
	if (r.startsWith("tool:")) return r.slice(5).trim() === tool;
	return globRegex(r).test(subject);
}

/** The decision the rules make for this request, or null to ask the orchestrator. */
export function decideApproval(
	tool: string,
	detail: string,
	rules: { allow: readonly string[]; deny: readonly string[] },
): { decision: ApprovalDecision; rule: string } | null {
	const subject = approvalSubject(detail);
	const commands = UNSAFE.test(subject) ? null : splitCommands(subject);
	const subjects = [subject, ...(commands && commands.length > 1 ? commands : [])];
	const deny = rules.deny.find((r) => subjects.some((s) => matches(r, tool, s)));
	if (deny) return { decision: "deny", rule: deny };
	const whole = rules.allow.find((r) => r.trim().startsWith("tool:") && matches(r, tool, subject));
	if (whole) return { decision: "approve", rule: whole };
	if (!commands) return null;
	const used: string[] = [];
	for (const command of commands) {
		const rule =
			tool === "bash" && NO_OPS.has(command)
				? NO_OP_RULE
				: rules.allow.find((r) => !r.trim().startsWith("tool:") && matches(r, tool, command));
		if (!rule) return null;
		if (!used.includes(rule)) used.push(rule);
	}
	return { decision: "approve", rule: used.join(", ") };
}
