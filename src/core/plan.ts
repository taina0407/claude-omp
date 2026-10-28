/**
 * Plan files for `omp-task plan apply`: a group of tasks with dependencies, written as YAML or
 * JSON. The CLI reads the file (briefs are paths relative to it); the daemon checks the graph
 * and creates the jobs in dependency order.
 *
 *   group: m4
 *   max_concurrent: 2
 *   budget_usd: 3
 *   defaults: { model: smol, access: edit }
 *   tasks:
 *     - name: schema
 *       brief: briefs/schema.md
 *     - name: api
 *       prompt: "Build the API on top of: {{result:schema}}"
 *       after: [schema]
 */
import { readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { z } from "zod";
import type { PlanBody } from "../api/schema";
import type { JobOptions } from "./jobs";
import { UsageError } from "./util";

const stringList = z.union([z.string(), z.array(z.string())]);

const taskFields = z.strictObject({
	model: z.string().optional(),
	preset: z.string().optional(),
	access: z.string().optional(),
	thinking: z.string().optional(),
	timeout: z.union([z.string(), z.number()]).optional(),
	isolate: z.string().optional(),
	carry_dirty: z.boolean().optional(),
	budget: z.number().positive().optional(),
	allow: z.array(z.string()).optional(),
	deny: z.array(z.string()).optional(),
	stall_timeout: z.union([z.string(), z.number()]).optional(),
	cwd: z.string().optional(),
	omp_args: z.string().optional(),
	files: z.array(z.string()).optional(),
});

const planFile = z.strictObject({
	group: z.string().optional(),
	max_concurrent: z.number().int().positive().optional(),
	budget_usd: z.number().positive().optional(),
	defaults: taskFields.optional(),
	tasks: z
		.array(
			taskFields.extend({
				name: z.string(),
				title: z.string().optional(),
				prompt: z.string().optional(),
				brief: z.string().optional(),
				after: stringList.optional(),
				after_any: z.boolean().optional(),
			}),
		)
		.min(1),
});

/** Reads a plan file into the daemon's request body. */
export function readPlanFile(path: string, clientCwd: string): PlanBody {
	const file = resolve(clientCwd, path);
	let raw: unknown;
	try {
		const text = readFileSync(file, "utf8");
		raw = extname(file) === ".json" ? JSON.parse(text) : Bun.YAML.parse(text);
	} catch (e) {
		throw new UsageError(`cannot read plan ${file}: ${(e as Error).message}`);
	}
	const parsed = planFile.safeParse(raw);
	if (!parsed.success) {
		throw new UsageError(`invalid plan ${file}: ${z.prettifyError(parsed.error)}`);
	}
	const plan = parsed.data;
	const base = dirname(file);
	const tasks = plan.tasks.map((t) => {
		const f = { ...plan.defaults, ...t };
		if (Boolean(t.prompt) === Boolean(t.brief)) {
			throw new UsageError(`task ${t.name}: give exactly one of prompt or brief`);
		}
		const prompt = t.brief ? readFileSync(resolve(base, t.brief), "utf8") : (t.prompt as string);
		const options: JobOptions = { prompt, clientCwd };
		if (f.model) options.model = f.model;
		if (f.preset) options.preset = f.preset;
		if (f.access) options.access = f.access;
		if (f.thinking) options.thinking = f.thinking;
		if (f.timeout !== undefined) options.timeout = String(f.timeout);
		if (f.isolate) options.isolate = f.isolate;
		if (f.carry_dirty) options.carryDirty = true;
		if (f.budget !== undefined) options.budget = f.budget;
		if (f.allow) options.allow = f.allow;
		if (f.deny) options.deny = f.deny;
		if (f.stall_timeout !== undefined) options.stallTimeout = String(f.stall_timeout);
		if (f.cwd) options.cwd = resolve(clientCwd, f.cwd);
		if (f.omp_args) options.ompArgs = f.omp_args;
		if (f.files) options.files = f.files.map((x) => resolve(base, x));
		options.title =
			t.title ?? `${t.name}: ${prompt.split("\n").find((l) => l.trim()) ?? ""}`.slice(0, 80);
		if (t.after_any) options.afterAny = true;
		const after = t.after === undefined ? [] : typeof t.after === "string" ? [t.after] : t.after;
		return { name: t.name, after, options };
	});
	const group = plan.group ?? basename(file, extname(file)).replace(/[^\w.-]/g, "-");
	const body: PlanBody = { group, tasks };
	if (plan.max_concurrent !== undefined) body.maxConcurrent = plan.max_concurrent;
	if (plan.budget_usd !== undefined) body.budgetUsd = plan.budget_usd;
	return body;
}

/**
 * The tasks in an order where every task comes after the tasks it depends on. `after` entries
 * that are not task names must be existing jobs (`isJob`).
 */
export function orderPlan<T extends { name: string; after: string[] }>(
	tasks: T[],
	isJob: (ref: string) => boolean,
): T[] {
	const byName = new Map<string, T>();
	for (const t of tasks) {
		if (byName.has(t.name)) throw new UsageError(`task name ${t.name} is used twice`);
		byName.set(t.name, t);
	}
	for (const t of tasks) {
		for (const dep of t.after) {
			if (!byName.has(dep) && !isJob(dep)) {
				throw new UsageError(`task ${t.name}: '${dep}' is neither a task in this plan nor a job`);
			}
		}
	}
	const ordered: T[] = [];
	const state = new Map<string, "visiting" | "done">();
	const visit = (t: T, path: string[]) => {
		if (state.get(t.name) === "done") return;
		if (state.get(t.name) === "visiting") {
			throw new UsageError(`dependency cycle: ${[...path, t.name].join(" → ")}`);
		}
		state.set(t.name, "visiting");
		for (const dep of t.after) {
			const d = byName.get(dep);
			if (d) visit(d, [...path, t.name]);
		}
		state.set(t.name, "done");
		ordered.push(t);
	};
	for (const t of tasks) visit(t, []);
	return ordered;
}
