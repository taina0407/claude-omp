/**
 * Approval rules: globs the daemon applies to a worker's approval request so routine commands
 * (`bun test*`) do not wake the orchestrator. A rule matches the command text (omp's
 * "Command: ..." line), or the whole tool when written `tool:<name>`. `*` matches any text and
 * `?` one character (`\*`, `\?` and `\\` match those characters); the match is anchored at both
 * ends.
 *
 * Deny rules win. A command line is split, outside quotes, into its commands at `&&`, `||`, `;`
 * and `|`: an allow rule approves it only when every command matches one, and a deny rule that
 * matches any command denies it. A rule without wildcards (what `approve --same` stores) may also
 * match the whole line. Background `&`, backticks, `$(`, `$'`, parentheses, unquoted newlines and
 * any redirect but `2>/dev/null`, `>/dev/null`, `1>/dev/null`, `&>/dev/null` and `2>&1` are never
 * approved by a command rule, so `bun test*` cannot approve `bun test | sh` or `bun test > f`.
 *
 * Built in, with no rule: the bash no-ops `true` and `:`, and commands that only read
 * (`builtin:read-only`): a short list of read-only programs (`ls`, `cat`, `grep`, `find` without
 * `-exec`/`-delete`, ...) given plain words only (no variables, globs or `~`), with absolute paths
 * and `..` kept inside the job's directories. omp's prompt shows only the command, so this needs
 * the bash call it belongs to: one that sets no environment variables and runs inside those
 * directories. `builtin:read-only` in the deny rules turns it off.
 *
 * omp shortens a long command in its prompt ("…[…120ch elided…]"); no allow rule approves that.
 */
import { isAbsolute, resolve } from "node:path";
import type { ApprovalDecision, ShellCall } from "./types";

/** Commands that do nothing, approved without a rule so a worker's `true` does not wake anyone. */
const NO_OPS: ReadonlySet<string> = new Set(["true", ":"]);
export const NO_OP_RULE = "builtin:no-op";
/** Approves read-only commands; listed in the deny rules it is off. */
export const READ_ONLY_RULE = "builtin:read-only";

/** What the rules may decide: the job's rules, and where its worker runs (for read-only checks). */
export interface ApprovalRules {
	allow: readonly string[];
	deny: readonly string[];
	/** The worker's working directory; without it no command is approved as read-only. */
	cwd?: string | null;
	/** Directories a read-only command may name (cwd, repository, worktree, extra dirs). */
	roots?: readonly string[];
}

/** One command of a command line. */
export interface ParsedCommand {
	/** The command's source text, without the allowed redirects. */
	text: string;
	/** Its words after quote removal. */
	words: string[];
	/** Only literal words: no variable, glob, brace, `~` or `#` the shell would expand. */
	plain: boolean;
	/** Part of a pipeline of two or more commands (it runs in a subshell). */
	piped: boolean;
}

/** How omp ends a command it shortened for the approval prompt. */
const ELIDED = /\[…\d+ch elided…\]$/;

/** Whether omp shortened this approval detail's command, so no rule can vouch for it. */
export function isShortened(detail: string): boolean {
	return ELIDED.test(approvalSubject(detail));
}

/** Redirects that only discard output, allowed after a word boundary. */
const QUIET_REDIRECT = /^(?:(?:[12]?>|&>)[ \t]*\/dev\/null|2>&1)(?=[ \t;&|]|$)/;

/**
 * The commands of a command line joined with `&&`, `||`, `;` or `|`, split outside quotes, or
 * null when it holds anything a command rule must never approve (see the file comment), an
 * unclosed quote or an empty command.
 */
export function parseCommands(command: string): ParsedCommand[] | null {
	const out: ParsedCommand[] = [];
	let text = "";
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let plain = true;
	let piped = false;
	const endWord = () => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	const endCommand = (nextPiped: boolean): boolean => {
		endWord();
		if (!words.length) return false;
		out.push({ text: text.trim(), words, plain, piped: piped || nextPiped });
		text = "";
		words = [];
		plain = true;
		piped = nextPiped;
		return true;
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i] as string;
		if (c === "'") {
			const end = command.indexOf("'", i + 1);
			if (end < 0) return null;
			word += command.slice(i + 1, end);
			text += command.slice(i, end + 1);
			inWord = true;
			i = end;
			continue;
		}
		if (c === '"') {
			let j = i + 1;
			for (; j < command.length && command[j] !== '"'; j++) {
				const d = command[j] as string;
				if (d === "\\") {
					const next = command[++j] ?? "";
					// Inside double quotes a backslash escapes only these; elsewhere it stays.
					word += '"\\$`'.includes(next) ? next : `\\${next}`;
				} else if (d === "`" || (d === "$" && "('\"".includes(command[j + 1] ?? ""))) {
					return null;
				} else {
					if (d === "$") plain = false;
					word += d;
				}
			}
			if (j >= command.length) return null;
			text += command.slice(i, j + 1);
			inWord = true;
			i = j;
			continue;
		}
		if (c === "\\") {
			const next = command[i + 1];
			if (next === undefined || next === "\n" || next === "\r") return null;
			word += next;
			text += c + next;
			inWord = true;
			i++;
			continue;
		}
		if (!inWord) {
			const quiet = QUIET_REDIRECT.exec(command.slice(i));
			if (quiet) {
				i += quiet[0].length - 1;
				continue;
			}
		}
		if (c === " " || c === "\t") {
			endWord();
			text += c;
			continue;
		}
		const pair = command.slice(i, i + 2);
		if (pair === "&&" || pair === "||") {
			if (!endCommand(false)) return null;
			i++;
			continue;
		}
		if (c === ";") {
			if (!endCommand(false)) return null;
			continue;
		}
		if (c === "|") {
			if (command[i + 1] === "&" || !endCommand(true)) return null;
			continue;
		}
		if ("&<>()`\n\r".includes(c)) return null;
		if (c === "$") {
			if ("('\"".includes(command[i + 1] ?? "")) return null;
			plain = false;
		}
		if ("*?[]{}".includes(c) || (!inWord && (c === "~" || c === "#"))) plain = false;
		word += c;
		text += c;
		inWord = true;
	}
	return endCommand(false) ? out : null;
}

/** The commands' texts (see parseCommands), or null. */
export function splitCommands(command: string): string[] | null {
	return parseCommands(command)?.map((c) => c.text) ?? null;
}

function globRegex(glob: string): RegExp {
	let body = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i] as string;
		const next = glob[i + 1];
		if (c === "\\" && (next === "*" || next === "?" || next === "\\")) {
			body += `\\${next}`;
			i++;
		} else if (c === "*") body += ".*";
		else if (c === "?") body += ".";
		else body += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${body}$`, "s");
}

/** A rule that matches exactly this text and nothing else. */
export function literalRule(text: string): string {
	return text.replace(/[\\*?]/g, "\\$&");
}

/** Whether a rule has no wildcard, so it matches one text only. */
function isLiteral(rule: string): boolean {
	return !/(^|[^\\])(\\\\)*[*?]/.test(rule);
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

/** `-x` options in a short-option cluster (`-nf` holds `f`). */
function shortFlags(args: readonly string[]): string {
	return args
		.filter((a) => /^-[^-]/.test(a))
		.map((a) => a.slice(1))
		.join("");
}

function hasOption(args: readonly string[], names: readonly string[]): boolean {
	return args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));
}

const operands = (args: readonly string[]) => args.filter((a) => !a.startsWith("-"));

type ArgsCheck = (args: string[]) => boolean;

const FIND_ACTIONS = [
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-delete",
	"-fls",
	"-fprint",
	"-fprint0",
	"-fprintf",
];

/**
 * Programs that only read, each with the arguments that would make it write, run another program
 * or never end. Git is not here: repository configuration can make even `git status` run a helper.
 */
const READ_ONLY = new Map<string, ArgsCheck>([
	...[
		"cat",
		"cut",
		"echo",
		"expr",
		"false",
		"grep",
		"head",
		"id",
		"ls",
		"nl",
		"numfmt",
		"paste",
		"pwd",
		"rev",
		"seq",
		"stat",
		"tac",
		"tr",
		"true",
		"uname",
		"wc",
		"which",
		"whoami",
	].map((name): [string, ArgsCheck] => [name, () => true]),
	["base64", (a) => !hasOption(a, ["-o", "--output"])],
	["find", (a) => !a.some((x) => FIND_ACTIONS.includes(x))],
	[
		"rg",
		(a) =>
			!hasOption(a, ["--pre", "--hostname-bin", "--search-zip"]) && !shortFlags(a).includes("z"),
	],
	// `sed -n 12p FILE` / `sed -n '1,40p' FILE` / `sed -n '200,$p' FILE`.
	["sed", (a) => a.length <= 3 && a[0] === "-n" && /^(\d+,)?(\d+|\$)p$/.test(a[1] ?? "")],
	[
		"sort",
		(a) => !hasOption(a, ["--output", "--compress-program"]) && !shortFlags(a).includes("o"),
	],
	["tail", (a) => !hasOption(a, ["--follow", "--retry"]) && !/[fF]/.test(shortFlags(a))],
	// `uniq IN OUT` writes OUT.
	["uniq", (a) => operands(a).length <= 1],
]);

function inside(path: string, roots: readonly string[]): boolean {
	return path === "/dev/null" || roots.some((r) => path === r || path.startsWith(`${r}/`));
}

/** Absolute paths and paths with `..` must stay inside the roots from every possible cwd. */
function pathsInside(args: readonly string[], cwds: readonly string[], roots: readonly string[]) {
	for (const arg of args) {
		const value = arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
		if (isAbsolute(value)) {
			if (!inside(resolve(value), roots)) return false;
		} else if (value.split("/").includes("..")) {
			if (!cwds.every((cwd) => inside(resolve(cwd, value), roots))) return false;
		}
	}
	return true;
}

/**
 * Whether a command only reads, given the directories it may run in. Returns the directories the
 * next command may run in (a `cd` adds its target: it may also fail), or null when it does not
 * only read.
 */
function readOnly(
	cmd: ParsedCommand,
	cwds: readonly string[],
	roots: readonly string[],
): string[] | null {
	if (!cmd.plain) return null;
	const [name = "", ...args] = cmd.words;
	if (name === "cd") {
		// In a pipeline cd runs in a subshell; `cd`, `cd -` and options need a home or history.
		const dir = args[0];
		if (cmd.piped || args.length !== 1 || !dir || dir.startsWith("-")) return null;
		const targets = cwds.map((cwd) => resolve(cwd, dir));
		if (!targets.every((t) => inside(t, roots))) return null;
		return [...new Set([...cwds, ...targets])];
	}
	if (!READ_ONLY.get(name)?.(args) || !pathsInside(args, cwds, roots)) return null;
	return [...cwds];
}

/**
 * The decision the rules make for this request, or null to ask the orchestrator. `shell` is the
 * bash call the request is for, when known; without it nothing is approved as read-only.
 */
export function decideApproval(
	tool: string,
	detail: string,
	rules: ApprovalRules,
	shell?: ShellCall,
): { decision: ApprovalDecision; rule: string } | null {
	const subject = approvalSubject(detail);
	const commands = parseCommands(subject);
	const subjects = [
		subject,
		...(commands && commands.length > 1 ? commands.map((c) => c.text) : []),
	];
	const deny = rules.deny.find(
		(r) => r.trim() !== READ_ONLY_RULE && subjects.some((s) => matches(r, tool, s)),
	);
	if (deny) return { decision: "deny", rule: deny };
	if (ELIDED.test(subject)) return null;
	const whole = rules.allow.find(
		(r) => (r.trim().startsWith("tool:") || isLiteral(r.trim())) && matches(r, tool, subject),
	);
	if (whole) return { decision: "approve", rule: whole };
	if (!commands) return null;
	const roots = [...new Set([rules.cwd ?? "", ...(rules.roots ?? [])].filter(Boolean))].map((r) =>
		resolve(r),
	);
	const start = rules.cwd && shell ? resolve(rules.cwd, shell.cwd ?? ".") : null;
	const readOnlyOn =
		tool === "bash" &&
		start !== null &&
		!shell?.env &&
		inside(start, roots) &&
		!rules.deny.some((r) => r.trim() === READ_ONLY_RULE);
	// The directories the next command may run in; null once a rule-approved command may have
	// moved it somewhere unknown.
	let cwds: string[] | null = start ? [start] : null;
	const used: string[] = [];
	for (const command of commands) {
		let rule: string | undefined;
		const next = readOnlyOn && cwds ? readOnly(command, cwds, roots) : null;
		if (tool === "bash" && NO_OPS.has(command.text)) rule = NO_OP_RULE;
		else {
			rule = rules.allow.find(
				(r) => !r.trim().startsWith("tool:") && matches(r, tool, command.text),
			);
			if (rule) {
				if (command.words[0] === "cd" || command.words[0] === "pushd") cwds = null;
			} else if (next) {
				rule = READ_ONLY_RULE;
				cwds = next;
			}
		}
		if (!rule) return null;
		if (!used.includes(rule)) used.push(rule);
	}
	return { decision: "approve", rule: used.join(", ") };
}
