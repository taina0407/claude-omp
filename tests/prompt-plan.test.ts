/** The "no drift" mapping of a worker's question to the UI (hooks/prompt-plan.ts). */
import { describe, expect, test } from "bun:test";
import {
	type AskPlan,
	cutLabel,
	headerFor,
	normalizeOptions,
	type PromptItem,
	paneAnswer,
	planPrompt,
	readAnswer,
	readLabel,
	shortId,
	suggestRule,
	uniqueLabels,
} from "../hooks/prompt-plan";

const JOB = "7f3a9c01deadbeef";

function q(options: string[], extra: Partial<PromptItem> = {}): PromptItem {
	return {
		ref: "q-1",
		kind: "question",
		text: "Which one?",
		tool: null,
		options,
		context: null,
		...extra,
	};
}

function ask(options: string[], extra: Partial<PromptItem> = {}, note?: string): AskPlan {
	const plan = planPrompt(q(options, extra), JOB, note);
	if (plan.ui !== "ask") throw new Error(`expected the dialog, got the pane: ${plan.reason}`);
	return plan;
}

/** The invariants: 2-4 options, and every label stands for exactly one of the worker's options. */
function checkInvariants(plan: AskPlan, options: string[]): void {
	const opts = normalizeOptions(options);
	const shown = plan.input.questions[0].options;
	expect(shown.length).toBeGreaterThanOrEqual(2);
	expect(shown.length).toBeLessThanOrEqual(4);
	expect(shown.length).toBe(opts.length);
	expect(new Set(shown.map((o) => o.label.toLowerCase())).size).toBe(shown.length);
	expect(shown.some((o) => o.label.toLowerCase() === "other")).toBe(false);
	for (const o of shown) expect(opts).toContain(plan.valueOf.get(o.label) as string);
	expect(new Set(plan.valueOf.values()).size).toBe(opts.length);
	for (const o of shown) expect(o.label.length).toBeLessThanOrEqual(44);
}

describe("choosing the UI", () => {
	test("no options: the pane's text field", () => {
		expect(planPrompt(q([]), JOB)).toMatchObject({ ui: "pane", mode: "question-free" });
		expect(planPrompt(q(["  ", ""]), JOB)).toMatchObject({ ui: "pane", mode: "question-free" });
	});

	test("one option, or more than four: the pane's numbered list", () => {
		expect(planPrompt(q(["Only"]), JOB)).toMatchObject({ ui: "pane", mode: "question-choice" });
		const five = ["a", "b", "c", "d", "e"];
		expect(planPrompt(q(five), JOB)).toMatchObject({
			ui: "pane",
			mode: "question-choice",
			options: five,
		});
	});

	test("exactly four options: the dialog", () => {
		const four = ["a", "b", "c", "d"];
		checkInvariants(ask(four), four);
	});

	test("an option with a line break, or longer than 300 characters: the pane", () => {
		expect(planPrompt(q(["a\nb", "c"]), JOB)).toMatchObject({ ui: "pane" });
		expect(planPrompt(q(["x".repeat(301), "c"]), JOB)).toMatchObject({ ui: "pane" });
		checkInvariants(ask(["x".repeat(300), "c"]), ["x".repeat(300), "c"]);
	});

	test("a question longer than 1000 characters with its context: the pane", () => {
		expect(
			planPrompt(q(["a", "b"], { text: "q".repeat(600), context: "c".repeat(401) }), JOB),
		).toMatchObject({ ui: "pane", mode: "question-choice" });
		ask(["a", "b"], { text: "q".repeat(600), context: "c".repeat(398) });
	});

	test("approvals always use the pane", () => {
		const plan = planPrompt(
			{ ...q(["Approve", "Deny"]), kind: "approval", tool: "bash", text: "bun test" },
			JOB,
		);
		expect(plan).toMatchObject({ ui: "pane", mode: "approval" });
	});

	test("repeats after normalising count once", () => {
		const plan = ask([" Yes ", "yes", "No", "NO", ""]);
		expect(plan.input.questions[0].options.map((o) => o.label)).toEqual(["Yes", "No"]);
		expect(planPrompt(q(["Same", "same "]), JOB)).toMatchObject({ ui: "pane" });
	});
});

describe("building the dialog", () => {
	test("one single-select question with the job's chip; context and note follow the question", () => {
		const plan = ask(["a", "b"], { context: "Some context" }, "Claude says hi");
		const [question] = plan.input.questions;
		expect(question.header).toBe("omp 7f3a9c01");
		expect(question.header.length).toBeLessThanOrEqual(12);
		expect(question.multiSelect).toBe(false);
		expect(question.question).toBe("Which one?\n\nSome context\n\nClaude says hi");
		expect(plan.question).toBe(question.question);
		expect(headerFor("abc")).toBe("omp abc");
	});

	test("no question mark is added", () => {
		expect(ask(["a", "b"], { text: "Pick one" }).question).toBe("Pick one");
	});

	test("labels of 40 characters stay whole; 41 are cut at a space with the option as description", () => {
		const forty = `${"a".repeat(19)} ${"b".repeat(20)}`;
		const fortyOne = `${"a".repeat(19)} ${"b".repeat(21)}`;
		expect(forty.length).toBe(40);
		const plan = ask([forty, fortyOne]);
		const [first, second] = plan.input.questions[0].options;
		expect(first).toEqual({ label: forty, description: "" });
		expect(second?.label).toBe(`${"a".repeat(19)}…`);
		expect(second?.description).toBe(fortyOne);
		expect(plan.valueOf.get(second?.label as string)).toBe(fortyOne);
		expect(cutLabel("x".repeat(50))).toBe(`${"x".repeat(37)}…`);
	});

	test("labels that collide after cutting get numbered", () => {
		const base = "Use the configuration from the shared workspace";
		const options = [`${base} A`, `${base} B`, `${base} C`];
		const plan = ask(options);
		const labels = plan.input.questions[0].options.map((o) => o.label);
		expect(labels[0]).toBe(cutLabel(options[0] as string));
		expect(labels[1]).toBe(`${labels[0]} (1)`);
		expect(labels[2]).toBe(`${labels[0]} (2)`);
		checkInvariants(plan, options);
	});

	test("an option named Other is renamed, so it is not taken for the dialog's own", () => {
		const plan = ask(["other", "Keep"]);
		const labels = plan.input.questions[0].options.map((o) => o.label);
		expect(labels).toEqual(["other (1)", "Keep"]);
		expect(plan.valueOf.get("other (1)")).toBe("other");
		expect(uniqueLabels(["Other", "Other (1)"])).toEqual(["Other (1)", "Other (1) (1)"]);
	});
});

describe("reading the dialog's answer", () => {
	const options = ["Use the configuration from the shared workspace", "Skip"];
	const plan = ask(options);
	const long = plan.input.questions[0].options[0]?.label as string;
	const answers = (a: string) => ({ result: { answers: { [plan.question]: a } } });

	test("a picked label sends the worker's whole option", () => {
		expect(readAnswer(plan, answers(long))).toEqual({
			kind: "answer",
			value: options[0] as string,
			source: "option",
		});
	});

	test("typed text that equals a label counts as that option", () => {
		expect(readAnswer(plan, answers("Skip"))).toMatchObject({ value: "Skip", source: "option" });
	});

	test("other typed text is sent as typed, trimmed", () => {
		expect(readAnswer(plan, answers("  do both  "))).toEqual({
			kind: "answer",
			value: "do both",
			source: "typed",
		});
	});

	test("a free-form response is sent as typed", () => {
		expect(readAnswer(plan, { result: { answers: {}, response: " my way " } })).toEqual({
			kind: "answer",
			value: "my way",
			source: "typed",
		});
	});

	test("an answer the dialog gave while the user was away is never sent", () => {
		expect(
			readAnswer(plan, { result: { answers: { [plan.question]: "Skip" }, afkTimeoutMs: 60000 } }),
		).toMatchObject({ kind: "dismissed" });
	});

	test("follow-up, notes only, empty, refused and errored answers send nothing", () => {
		expect(readAnswer(plan, { result: { answers: {}, followUp: true } }).kind).toBe("dismissed");
		expect(readAnswer(plan, answers("(notes only)")).kind).toBe("dismissed");
		expect(readAnswer(plan, answers("   ")).kind).toBe("dismissed");
		expect(readAnswer(plan, { result: { answers: {} } }).kind).toBe("dismissed");
		expect(readAnswer(plan, { deny: "no" }).kind).toBe("dismissed");
		expect(readAnswer(plan, { isError: true, result: "User declined" }).kind).toBe("dismissed");
	});
});

describe("pane answers and rules", () => {
	test("a number picks the option; anything else is sent as typed", () => {
		const opts = ["a", "b", "c", "d", "e"];
		expect(paneAnswer(opts, " 2 ")).toBe("b");
		expect(paneAnswer(opts, "9")).toBe("9");
		expect(paneAnswer(opts, "free text")).toBe("free text");
		expect(paneAnswer(opts, "  ")).toBeNull();
	});

	test("the suggested rule is the command's prefix", () => {
		expect(suggestRule("bun test src/auth")).toBe("bun test*");
		expect(suggestRule("ls -la")).toBe("ls*");
		expect(suggestRule("./script.sh arg")).toBe("./script.sh arg*");
		expect(suggestRule("")).toBe("*");
	});
});

describe("what $.ui.ask shows", () => {
	test("cut options are listed whole in the question; labels and chip are ready", () => {
		const long = "Use the configuration from the shared workspace";
		const plan = ask([long, "Skip"]);
		expect(plan.labels).toEqual([cutLabel(long), "Skip"]);
		expect(plan.header).toBe("omp 7f3a9c01");
		expect(plan.question).toBe(`Which one?\n\n1. ${long}\n- Skip`);
		expect(ask(["a", "b"]).question).toBe("Which one?");
	});

	test("readLabel maps a label back to its option; other text is typed", () => {
		const long = "Use the configuration from the shared workspace";
		const plan = ask([long, "Skip"]);
		expect(readLabel(plan, cutLabel(long))).toEqual({
			kind: "answer",
			value: long,
			source: "option",
		});
		expect(readLabel(plan, " mine ")).toEqual({ kind: "answer", value: "mine", source: "typed" });
		expect(readLabel(plan, "(notes only)").kind).toBe("dismissed");
		expect(readLabel(plan, "").kind).toBe("dismissed");
	});
});

describe("short job ids", () => {
	test("omp-task ids show their random tail; other ids their first 8 characters", () => {
		expect(shortId("20261031-214709-9e09")).toBe("9e09");
		expect(headerFor("20261031-214709-9e09")).toBe("omp 9e09");
		expect(shortId("7f3a9c01deadbeef")).toBe("7f3a9c01");
	});
});
