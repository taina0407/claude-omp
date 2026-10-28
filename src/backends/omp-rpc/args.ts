/** Builds the `omp --mode rpc` command line for a session. */
import type { Access } from "../../core/types";
import type { SessionSpec } from "../types";

/**
 * Access levels map onto omp's tool set and approval mode. In RPC mode omp sends approval
 * prompts to the host, which forwards them to the orchestrator. Never add `--no-ui`: with it
 * omp denies those commands itself instead of asking.
 */
export const ACCESS_ARGS: Record<Access, string[]> = {
	read: ["--tools", "read,grep,find,glob,web_search,todo", "--approval-mode", "yolo"],
	edit: ["--approval-mode", "write"],
	full: ["--approval-mode", "yolo"],
};

export function buildArgs(spec: SessionSpec): string[] {
	const args = ["--mode", "rpc", "--no-title", ...ACCESS_ARGS[spec.access]];
	if (spec.model) args.push("--model", spec.model);
	if (spec.thinking) args.push("--thinking", spec.thinking);
	if (spec.resumeSession) args.push("--resume", spec.resumeSession);
	else if (spec.systemPromptFile) args.push("--append-system-prompt", spec.systemPromptFile);
	for (const dir of spec.addDirs) args.push("--add-dir", dir);
	args.push(...spec.extraArgs);
	return args;
}
