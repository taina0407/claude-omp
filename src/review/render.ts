/** Markdown for a submitted review: what `result` prints and what lands in result.md. */
import { type Finding, type Review, SEVERITIES } from "./schema";

const VERDICT_TEXT: Record<Review["verdict"], string> = {
	approve: "APPROVE",
	approve_with_comments: "APPROVE WITH COMMENTS",
	request_changes: "REQUEST CHANGES",
};

const rank = (f: Finding) => SEVERITIES.indexOf(f.severity);

export function renderReview(review: Review, target: string): string {
	const lines = [
		`# Review of ${target}: ${VERDICT_TEXT[review.verdict]}`,
		"",
		review.summary.trim(),
	];
	const findings = [...review.findings].sort((a, b) => rank(a) - rank(b));
	if (!findings.length) {
		lines.push("", "No findings.");
		return `${lines.join("\n")}\n`;
	}
	const counts = SEVERITIES.map(
		(s) => [s, findings.filter((f) => f.severity === s).length] as const,
	)
		.filter(([, n]) => n > 0)
		.map(([s, n]) => `${n} ${s}`);
	lines.push("", `## Findings (${counts.join(", ")})`);
	findings.forEach((f, i) => {
		const where = f.line ? `${f.file}:${f.line}` : f.file;
		lines.push(
			"",
			`${i + 1}. **[${f.severity}] ${f.title.trim()}** (\`${where}\`, confidence ${f.confidence.toFixed(2)})`,
		);
		for (const l of f.detail.trim().split("\n")) lines.push(`   ${l}`);
		if (f.suggestion?.trim()) lines.push(`   Suggestion: ${f.suggestion.trim()}`);
	});
	return `${lines.join("\n")}\n`;
}
