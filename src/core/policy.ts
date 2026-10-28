/**
 * Approval rules: globs the daemon applies to a worker's approval request so routine commands
 * (`bun test*`) do not wake the orchestrator. A rule matches the command text (omp's
 * "Command: ..." line), or the whole tool when written `tool:<name>`. `*` matches any text and
 * `?` one character; the match is anchored at both ends.
 *
 * Deny rules win. An allow rule never matches a command that chains or redirects (`;`, `&&`, `|`,
 * backticks, `$(`, `>`, `<`, newlines), so `bun test*` cannot approve `bun test; rm -rf ~`.
 */
import type { ApprovalDecision } from "./types";

const CHAINING = /[;&|`<>\n]|\$\(/;

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
	const deny = rules.deny.find((r) => matches(r, tool, subject));
	if (deny) return { decision: "deny", rule: deny };
	const allow = rules.allow.find(
		(r) => matches(r, tool, subject) && (r.trim().startsWith("tool:") || !CHAINING.test(subject)),
	);
	return allow ? { decision: "approve", rule: allow } : null;
}
