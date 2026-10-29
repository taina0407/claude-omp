import { describe, expect, test } from "bun:test";
import { orderPlan } from "../src/core/plan";
import {
	approvalSubject,
	decideApproval,
	isShortened,
	literalRule,
	NO_OP_RULE,
	READ_ONLY_RULE,
	splitCommands,
} from "../src/core/policy";
import type { ShellCall } from "../src/core/types";
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

describe("read-only commands", () => {
	const job = {
		allow: [] as string[],
		deny: [] as string[],
		cwd: "/repo",
		roots: ["/repo", "/extra"],
	};
	const own: ShellCall = { cwd: null, env: false };
	const decide = (command: string, rules = job, shell = own) =>
		decideApproval("bash", `Command: ${command}`, rules, shell);

	test("plain reads, pipes and quiet redirects need no rule", () => {
		for (const cmd of [
			"ls apps/backend/src 2>/dev/null; ls docs",
			"cat a.ts && echo --- && cat b.ts",
			'grep -rn "isList\\|readOnly" node_modules/@x/types.d.ts 2>/dev/null | head -20',
			"find apps/backend/src -type f | sort",
			"find . -name '*.ts' -not -path './node_modules/*'",
			"ls -la src 2>&1",
			"cd /repo/apps && wc -l a.ts b.ts",
			"cd apps/storefront && grep -n 'x' src/types.ts >/dev/null",
			"sed -n '1,40p' docs/plan.md",
			"sed -n '200,$p' docs/plan.md",
			"tail -n 50 log.txt | uniq -c",
			"rg -n foo /extra/lib",
			"head -c 100 /dev/null",
			"sort -u list.txt",
		]) {
			expect(decide(cmd)).toEqual({ decision: "approve", rule: READ_ONLY_RULE });
		}
	});

	test("anything that writes, runs another program, expands or never ends is asked", () => {
		for (const cmd of [
			"find . -name x -delete",
			"find . -exec cat {} \\;",
			"find . -fprint out",
			"sort -o a.txt a.txt",
			"sort -uo a.txt a.txt",
			"sort --compress-program=sh a",
			"uniq a.txt b.txt",
			"tail -f log.txt",
			"tail -nF 5 log.txt",
			"sed -i s/a/b/ x.ts",
			"sed -n '1p;w out' x.ts",
			"rg --pre ./x foo",
			"rg -z foo",
			"git status --porcelain",
			"git log -1",
			"node -p 1",
			"awk '{print}' a",
			"xargs cat",
			"curl -s https://example.com",
			"env",
			"constructor",
			"echo hi > a.txt",
			"echo hi >> a.txt",
			"ls 2>/tmp/x",
			"cat < a.txt",
			"ls src/*.ts",
			"ls src/?.ts",
			"cat ~/.ssh/id_rsa",
			"cat $HOME/x",
			'cat "$HOME/x"',
			"cat {a,b}",
			"ls $(pwd)",
			"ls `pwd`",
			"cat <(ls)",
			"ls & rm x",
			"ls\nrm x",
			"(ls)",
			"cat /etc/passwd",
			"cat ../outside.txt",
			"cat /repo/../etc/passwd",
			"cd /etc && cat passwd",
			"cd apps && cat ../../x",
			"cd a || true; cat ../x",
			"ls | cd /etc",
			"cd",
			"cd -",
			"ls; rm -rf x",
			"cat a | sh",
			"FOO=1 cat a",
			"/bin/cat a",
			"grep x -f /etc/passwd",
			"grep --file=/etc/passwd x",
		]) {
			expect([cmd, decide(cmd)]).toEqual([cmd, null]);
		}
	});

	test("it needs the bash call, without environment variables, run inside the job's directories", () => {
		expect(decideApproval("bash", "Command: ls", job)).toBeNull();
		expect(decide("ls", job, { cwd: null, env: true })).toBeNull();
		expect(decide("ls", job, { cwd: "/tmp", env: false })).toBeNull();
		expect(decide("ls", job, { cwd: "apps", env: false })).not.toBeNull();
		expect(decide("cat ../x", job, { cwd: "apps", env: false })).not.toBeNull();
		expect(decide("ls", { ...job, cwd: undefined } as never)).toBeNull();
		expect(decideApproval("edit", "Command: ls", job, own)).toBeNull();
	});

	test("builtin:read-only in the deny rules turns it off", () => {
		expect(decide("ls", { ...job, deny: [READ_ONLY_RULE] })).toBeNull();
		// The rule name denies nothing by itself.
		expect(decide("builtin:read-only", { ...job, deny: [READ_ONLY_RULE] })).toBeNull();
	});

	test("rules and read-only commands combine in one command line", () => {
		const rules = { ...job, allow: ["bun test*"] };
		expect(decide("bun test 2>&1 | tail -50", rules)).toEqual({
			decision: "approve",
			rule: `bun test*, ${READ_ONLY_RULE}`,
		});
		expect(decide("bun test | sh", rules)).toBeNull();
		// After a cd a rule approved, where commands run is unknown.
		expect(decide("cd x && ls", { ...job, allow: ["cd *"] })).toBeNull();
		expect(decide("ls && rm -rf x", { ...job, deny: ["rm -rf *"] })?.decision).toBe("deny");
	});
});

describe("approve --same and --rule", () => {
	const job = { allow: [] as string[], deny: [] as string[] };

	test("a literal rule matches its text only, and may cover a whole command line", () => {
		const cmd = "curl -s 'https://x.example/?q=a*b' | grep -c ok";
		const rule = literalRule(cmd);
		expect(decideApproval("bash", `Command: ${cmd}`, { ...job, allow: [rule] })).toEqual({
			decision: "approve",
			rule,
		});
		expect(
			decideApproval("bash", `Command: ${cmd.replace("a*b", "azzb")}`, { ...job, allow: [rule] }),
		).toBeNull();
		const odd = "echo `id`";
		expect(
			decideApproval("bash", `Command: ${odd}`, { ...job, allow: [literalRule(odd)] }),
		).not.toBeNull();
	});

	test("escaped wildcards in rules are literal", () => {
		expect(decideApproval("bash", "Command: ls a*", { ...job, allow: ["ls a\\*"] })).not.toBeNull();
		expect(decideApproval("bash", "Command: ls ab", { ...job, allow: ["ls a\\*"] })).toBeNull();
		expect(decideApproval("bash", "Command: ls ab", { ...job, allow: ["ls a*"] })).not.toBeNull();
	});

	test("a command omp shortened is never approved by a rule", () => {
		const detail = "Command: bun test x…[…120ch elided…]";
		expect(isShortened(detail)).toBe(true);
		expect(decideApproval("bash", detail, { ...job, allow: ["*"] })).toBeNull();
		expect(decideApproval("bash", detail, { ...job, deny: ["*"] })?.decision).toBe("deny");
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
