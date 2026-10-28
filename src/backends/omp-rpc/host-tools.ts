/** Tools the host registers inside omp so the worker can talk to the orchestrator. */

export const ASK_TOOL = "ask_orchestrator";
export const NOTIFY_TOOL = "notify_orchestrator";

export const HOST_TOOLS = [
	{
		name: ASK_TOOL,
		label: "Ask orchestrator",
		description:
			"Ask the orchestrating agent that assigned this task a question and wait for its answer. " +
			"Use it when the brief is ambiguous, a decision falls outside the brief, or you are blocked. " +
			"Do not use it for things you can find out yourself by reading the code.",
		parameters: {
			type: "object",
			properties: {
				question: { type: "string", description: "The question, self-contained." },
				options: {
					type: "array",
					items: { type: "string" },
					description: "Optional candidate answers, most likely first.",
				},
				context: {
					type: "string",
					description: "Optional short context the orchestrator needs.",
				},
			},
			required: ["question"],
		},
		loadMode: "essential",
	},
	{
		name: NOTIFY_TOOL,
		label: "Notify orchestrator",
		description:
			"Send a one-line progress note to the orchestrating agent without waiting for a reply. " +
			"Use it only at meaningful milestones (plan made, main change done, tests running).",
		parameters: {
			type: "object",
			properties: { message: { type: "string" } },
			required: ["message"],
		},
		loadMode: "essential",
	},
];

export const HOST_TOOL_NAMES: ReadonlySet<string> = new Set(HOST_TOOLS.map((t) => t.name));
