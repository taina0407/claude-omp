import { describe, expect, test } from "bun:test";
import { orderPlan } from "../src/core/plan";
import { approvalSubject, decideApproval } from "../src/core/policy";
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

	test("allow never matches chaining, pipes, redirects or substitutions", () => {
		for (const cmd of [
			"bun test; rm x",
			"bun test && x",
			"bun test | sh",
			"bun test > f",
			"bun test $(x)",
			"bun test `x`",
		]) {
			expect(decideApproval("bash", `Command: ${cmd}`, rules(["bun test*"]))).toBeNull();
		}
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
