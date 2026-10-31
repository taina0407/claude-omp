/**
 * How a worker's question or approval is put to the user, and how the answer is read back.
 *
 * The rule here is "no drift": every value sent back to the worker is either one of its own
 * options, exactly as it wrote it, or text the user typed. The engine's question dialog
 * (AskUserQuestion) is used only for 2-4 options, so it never invents a choice of its own, and an
 * answer the dialog gave by itself (the user was away) is never sent.
 *
 * Pure functions with no engine API, so the plugin's tests run them under `bun test`.
 */

/** The fields of a question or approval the plan reads (the daemon's `UiPending`). */
export interface PromptItem {
	ref: string;
	kind: "question" | "approval";
	text: string;
	tool: string | null;
	options: readonly string[];
	context: string | null;
	shortened?: boolean;
}

/** AskUserQuestion's input for one single-select question. */
export interface AskInput {
	questions: [
		{
			question: string;
			header: string;
			options: { label: string; description: string }[];
			multiSelect: false;
		},
	];
}

export interface AskPlan {
	ui: "ask";
	input: AskInput;
	/** The question as sent: the key of the dialog's `answers`. */
	question: string;
	/** The option labels as shown, in order (what `$.ui.ask` takes). */
	labels: string[];
	header: string;
	/** Each label shown → the worker's option it stands for. */
	valueOf: Map<string, string>;
}

export interface PanePlan {
	ui: "pane";
	mode: "question-free" | "question-choice" | "approval";
	/** Why the pane and not the dialog (for logs and tests). */
	reason: string;
	/** The normalised options, numbered in the pane. */
	options: string[];
}

export type PromptPlan = AskPlan | PanePlan;

/** What the dialog's answer means for the worker. */
export type AnswerOutcome =
	| { kind: "answer"; value: string; source: "option" | "typed" }
	| { kind: "dismissed"; reason: string };

/** The dialog's own result (`$.tool.call` of AskUserQuestion), loosely typed. */
export interface AskCallResult {
	deny?: string;
	isError?: true;
	result?: unknown;
}

export const MAX_OPTIONS = 4;
export const MAX_LABEL = 40;
export const LONG_OPTION = 300;
export const LONG_QUESTION = 1000;
/** What the dialog records for a question the user only annotated. */
export const NOTES_ONLY = "(notes only)";

/** Trims the options, drops empty ones and repeats (ignoring case; the first spelling stays). */
export function normalizeOptions(options: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of options) {
		const o = raw.trim();
		const key = o.toLowerCase();
		if (!o || seen.has(key)) continue;
		seen.add(key);
		out.push(o);
	}
	return out;
}

/**
 * A job id as the UI shows it: the random tail of `omp-task`'s `YYYYMMDD-HHMMSS-xxxx` ids (the
 * date part says nothing), else the first 8 characters.
 */
export function shortId(id: string): string {
	const m = /^\d{8}-\d{6}-(\w+)$/.exec(id);
	return m ? (m[1] as string) : id.slice(0, 8);
}

/** The dialog's chip: "omp " and the short job id (12 characters at most). */
export function headerFor(jobId: string): string {
	return `omp ${shortId(jobId)}`.slice(0, 12);
}

/** A label of at most MAX_LABEL characters: the option, or its start cut at a space and "…". */
export function cutLabel(option: string): string {
	if (option.length <= MAX_LABEL) return option;
	const head = option.slice(0, MAX_LABEL - 3);
	const space = head.lastIndexOf(" ");
	return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** Labels made unique (ignoring case, and never "Other", which the dialog adds itself). */
export function uniqueLabels(labels: readonly string[]): string[] {
	const taken = new Set<string>(["other"]);
	return labels.map((label) => {
		let out = label;
		for (let n = 1; taken.has(out.toLowerCase()); n++) out = `${label} (${n})`;
		taken.add(out.toLowerCase());
		return out;
	});
}

/** How to put one question or approval of a job to the user. */
export function planPrompt(item: PromptItem, jobId: string, note?: string): PromptPlan {
	const options = normalizeOptions(item.options);
	if (item.kind === "approval") {
		return { ui: "pane", mode: "approval", reason: "approvals always use the pane", options };
	}
	const n = options.length;
	const pane = (mode: PanePlan["mode"], reason: string): PanePlan => ({
		ui: "pane",
		mode,
		reason,
		options,
	});
	if (n === 0) return pane("question-free", "no options");
	if (n === 1 || n > MAX_OPTIONS) return pane("question-choice", `${n} option(s)`);
	if (options.some((o) => o.includes("\n") || o.length > LONG_OPTION)) {
		return pane("question-choice", "an option is multi-line or long");
	}
	const extra = [item.context?.trim(), note?.trim()].filter((s): s is string => !!s);
	if (item.text.length + extra.join("\n\n").length > LONG_QUESTION) {
		return pane("question-choice", "the question is long");
	}
	const labels = uniqueLabels(options.map(cutLabel));
	// `$.ui.ask` shows labels only: a cut option is listed whole in the question.
	const cutOnes = options.filter((o, i) => labels[i] !== o);
	const whole = cutOnes.length
		? [options.map((o, i) => `${labels[i] === o ? "-" : `${i + 1}.`} ${o}`).join("\n")]
		: [];
	const question = [item.text, ...extra, ...whole].join("\n\n");
	const values = new Map<string, string>();
	const shown = options.map((o, i) => {
		const label = labels[i] as string;
		values.set(label, o);
		return { label, description: label === o ? "" : o };
	});
	return {
		ui: "ask",
		question,
		labels,
		header: headerFor(jobId),
		valueOf: values,
		input: {
			questions: [{ question, header: headerFor(jobId), options: shown, multiSelect: false }],
		},
	};
}

/** Reads the dialog's result: the worker's option the user picked, text they typed, or nothing. */
export function readAnswer(plan: AskPlan, call: AskCallResult): AnswerOutcome {
	if (call.deny !== undefined) {
		return { kind: "dismissed", reason: `the dialog was refused (${call.deny})` };
	}
	if (call.isError) return { kind: "dismissed", reason: "the user declined to answer" };
	const r = (call.result ?? {}) as {
		answers?: Record<string, unknown>;
		response?: unknown;
		afkTimeoutMs?: unknown;
		followUp?: unknown;
	};
	if (r.afkTimeoutMs !== undefined) {
		return { kind: "dismissed", reason: "the dialog closed itself while the user was away" };
	}
	if (r.followUp === true) return { kind: "dismissed", reason: "the user asked to talk instead" };
	const answers = r.answers ?? {};
	const keys = Object.keys(answers);
	const raw =
		answers[plan.question] ?? (keys.length === 1 ? answers[keys[0] as string] : undefined);
	const picked = typeof raw === "string" ? raw.trim() : "";
	if (picked && plan.valueOf.has(picked)) {
		return { kind: "answer", value: plan.valueOf.get(picked) as string, source: "option" };
	}
	if (picked && picked !== NOTES_ONLY) return { kind: "answer", value: picked, source: "typed" };
	const response = typeof r.response === "string" ? r.response.trim() : "";
	if (response) return { kind: "answer", value: response, source: "typed" };
	return { kind: "dismissed", reason: "no answer" };
}

/**
 * Reads what `$.ui.ask` resolved to when the dialog's own result was not seen: a label is the
 * worker's option it stands for, anything else is text the user typed.
 */
export function readLabel(plan: AskPlan, answer: string): AnswerOutcome {
	const picked = answer.trim();
	if (!picked || picked === NOTES_ONLY) return { kind: "dismissed", reason: "no answer" };
	const value = plan.valueOf.get(picked);
	return value !== undefined
		? { kind: "answer", value, source: "option" }
		: { kind: "answer", value: picked, source: "typed" };
}

/** What a pane answer to a numbered list means: "2" → the second option, else the text typed. */
export function paneAnswer(options: readonly string[], typed: string): string | null {
	const text = typed.trim();
	if (!text) return null;
	if (/^\d+$/.test(text)) {
		const picked = options[Number(text) - 1];
		if (picked !== undefined) return picked;
	}
	return text;
}

/**
 * The rule the approval dialog suggests: the command's first word, and its second when that is a
 * plain word (a subcommand), then "*". `bun test src/a.ts` → `bun test*`.
 */
export function suggestRule(command: string): string {
	const words = command.trim().split(/\s+/);
	const [first, second] = words;
	if (!first) return "*";
	return second && /^[a-z][\w:.-]*$/i.test(second) ? `${first} ${second}*` : `${first}*`;
}
