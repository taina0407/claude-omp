// The omp plugin's mod (hooks/register.tsx): the values it keeps in `$.state`, and the shapes of
// what `omp-task ui-state` / `ui-feed` print (src/api/schema.ts: UiSnapshot, UiJob, UiPending).

export type OmpDecider = "claude" | "both" | "user";

export type OmpPending = {
	jobId: string;
	ref: string;
	kind: "question" | "approval";
	text: string;
	tool: string | null;
	options: string[];
	context: string | null;
	askedAt: string;
	shortened: boolean;
	/** The command without omp's `Command:` label (an approval); the text for a question. */
	subject: string;
};

export type OmpJob = {
	id: string;
	title: string | null;
	status: string;
	model: string | null;
	access: string;
	group: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	durationS: number | null;
	costUsd: number;
	budgetUsd: number | null;
	queueReason: string | null;
	worktreePath: string | null;
	lastActivity: { ts: string; kind: string; text: string } | null;
	pending: OmpPending[];
	changedFiles: number | null;
	cwd: string;
};

export type OmpUiSettings = {
	decider: OmpDecider;
	notify: boolean;
	band: "auto" | "always" | "off";
	recentS: number;
};

export type OmpSnapshot = {
	daemon: "up";
	version: string;
	generatedAt: string;
	decider: OmpDecider;
	deciderSource: "session" | "config";
	ui: OmpUiSettings;
	jobs: OmpJob[];
};

/** What the mod last heard from the daemon. */
export type OmpView =
	| OmpSnapshot
	| { daemon: "down"; ui: OmpUiSettings }
	| { daemon: "outdated"; version: string; ui: OmpUiSettings };

export type OmpFeedState = "live" | "idle" | "down" | "error" | "outdated";

/** The one dialog open at a time: a question or approval of a job, in the pane or the dialog. */
export type OmpDialog = {
	job: string;
	ref: string;
	via: "ask" | "pane";
	/** The note Claude passed to ask_user, shown with the question. */
	note: string | null;
	/** What the daemon or the CLI last refused (a rule, a stale ref), shown verbatim. */
	error: string | null;
	/** The approval dialog's rule field, while the user edits it. */
	rule: string | null;
	/** The approval dialog's message field (deny with message), while open. */
	message: string | null;
};

declare module "claude-code" {
	interface PluginState {
		omp: {
			view: Shaped<OmpView | null>;
			feedState: OmpFeedState;
			/** `job:ref` or `job:status` already toasted or notified. */
			seen: Record<string, string>;
			dialog: Shaped<OmpDialog | null>;
			/** `job:ref` items waiting for their dialog, in order. */
			queue: string[];
			bandHidden: boolean;
			/** The pane's read-only details view (`omp-task status <id>`), or null. */
			details: { job: string; text: string } | null;
			/** A job whose Cancel was pressed once and waits for the confirmation. */
			confirmCancel: string | null;
		};
	}
}
