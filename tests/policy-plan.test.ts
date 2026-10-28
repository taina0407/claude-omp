import { describe, expect, test } from "bun:test";
import { orderPlan } from "../src/core/plan";
import { approvalSubject, decideApproval, NO_OP_RULE, splitCommands } from "../src/core/policy";
import { UsageError } from "../src/core/util";

describe("approval rules", () => {
	const rules = (allow: string[], deny: string[] = []) => ({ allow, deny });

	test("the subject is the command without omp's label", () => {
		expect(approvalSubject("Command: bun test --watch")).toBe("bun test --watch");
		expect(approvalSubject("edit")).toBe("edit");
	});

	test("globs match the whole command", () => {
		expect(decideApproval("bash", "Command: bun test", rules(["bun test*"]))?.decision).toBe(
			"approve",
		);
		expect(decideApproval("bash", "Command: bun test a.ts", rules(["bun test"]))).toBeNull();
		expect(decideApproval("bash", "Command: git diff", rules(["git ?iff"]))?.rule).toBe("git ?iff");
	});

	test("regex characters in a rule are literal", () => {
		expect(decideApproval("bash", "Command: bun run x.ts", rules(["bun run x.ts"]))).not.toBeNull();
		expect(decideApproval("bash", "Command: bun run xyts", rules(["bun run x.ts"]))).toBeNull();
	});

	test("deny wins, and applies even to chained commands", () => {
		const r = rules(["rm *"], ["rm -rf *"]);
		expect(decideApproval("bash", "Command: rm -rf /", r)?.decision).toBe("deny");
		expect(decideApproval("bash", "Command: ls; rm -rf x", rules([], ["*rm -rf*"]))?.decision).toBe(
			"deny",
		);
	});

	test("allow never matches pipes, redirects, substitutions or an unmatched chained command", () => {
		for (const cmd of [
			"bun test; rm x",
			"bun test && x",
			"bun test || x",
			"bun test | sh",
			"bun test & x",
			"bun test > f",
			"bun test $(x)",
			"bun test `x`",
			"bun test\nrm x",
			"bun test 'a; rm x",
			"bun test &&",
		]) {
			expect(decideApproval("bash", `Command: ${cmd}`, rules(["bun test*"]))).toBeNull();
		}
	});

	test("a chain is approved when every command matches an allow rule", () => {
		const r = rules(["mkdir -p src/*", "cp /tmp/fixtures/*"]);
		const d = decideApproval("bash", "Command: mkdir -p src/x && cp /tmp/fixtures/a.xml src/x/", r);
		expect(d).toEqual({ decision: "approve", rule: "mkdir -p src/*, cp /tmp/fixtures/*" });
		expect(
			decideApproval("bash", "Command: mkdir -p src/x; cp /tmp/fixtures/a src/", r),
		).not.toBeNull();
		expect(decideApproval("bash", "Command: mkdir -p src/x && cp ~/.ssh/id src/", r)).toBeNull();
	});

	test("separators inside quotes do not split a command", () => {
		expect(splitCommands(`git log --format="%h; %s" && echo 'a && b'`)).toEqual([
			`git log --format="%h; %s"`,
			"echo 'a && b'",
		]);
		expect(splitCommands("echo a\\;b")).toEqual(["echo a\\;b"]);
		expect(splitCommands("echo a\\\\;b")).toEqual(["echo a\\\\", "b"]);
		// A quoted separator stays inside the command, so `bun test*` covers it.
		expect(
			decideApproval("bash", `Command: bun test -t "a; b"`, rules(["bun test*"])),
		).not.toBeNull();
	});

	test("deny matches each command of a chain", () => {
		expect(
			decideApproval("bash", "Command: bun test && rm -rf x", rules(["*"], ["rm -rf *"]))?.decision,
		).toBe("deny");
	});

	test("bash no-ops need no rule", () => {
		expect(decideApproval("bash", "Command: true", rules([]))).toEqual({
			decision: "approve",
			rule: NO_OP_RULE,
		});
		expect(decideApproval("bash", "Command: :", rules([]))?.decision).toBe("approve");
		expect(
			decideApproval("bash", "Command: true && bun test", rules(["bun test*"])),
		).not.toBeNull();
		expect(decideApproval("bash", "Command: true && rm x", rules([]))).toBeNull();
		expect(decideApproval("bash", "Command: true", rules([], ["tool:bash"]))?.decision).toBe(
			"deny",
		);
		expect(decideApproval("edit", "Path: true", rules([]))).toBeNull();
	});

	test("tool:<name> matches a whole tool", () => {
		expect(decideApproval("edit", "Path: a.ts", rules(["tool:edit"]))?.decision).toBe("approve");
		expect(decideApproval("bash", "Command: x", rules(["tool:edit"]))).toBeNull();
	});
});

describe("orderPlan", () => {
	const t = (name: string, after: string[] = []) => ({ name, after });

	test("dependencies come first, otherwise file order", () => {
		const order = orderPlan(
			[t("d", ["b", "c"]), t("b", ["a"]), t("c", ["a"]), t("a")],
			() => false,
		);
		expect(order.map((x) => x.name)).toEqual(["a", "b", "c", "d"]);
	});

	test("existing jobs are accepted as dependencies", () => {
		expect(orderPlan([t("a", ["20260101-000000-abcd"])], (r) => r.startsWith("2026"))).toHaveLength(
			1,
		);
	});

	test("cycles, duplicates and unknown names are usage errors", () => {
		expect(() => orderPlan([t("a", ["b"]), t("b", ["a"])], () => false)).toThrow("a → b → a");
		expect(() => orderPlan([t("a"), t("a")], () => false)).toThrow(UsageError);
		expect(() => orderPlan([t("a", ["x"])], () => false)).toThrow("'x' is neither");
	});
});
