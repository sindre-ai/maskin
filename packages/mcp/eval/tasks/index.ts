import { H6_TASK_ID } from '../lib/summary'
import type { CheckResult, ObjectRow, Seed, TaskContext, TaskDef } from '../lib/types'

// Each task prompt describes the outcome in plain words. None of them names an
// argument: the whole point is to see which spelling the agent reaches for.
// Outcomes are checked against staging state with plain queries. No LLM judge.

export const HELPER_AGENT_NAME = 'eval-helper'
export const H6_SKILL_NAME = 'eval-h6-skill-lookup'
// Exactly the seed content Infra & DevOps documented in the staging runbook.
export const H6_SEED_CONTENT = [
	'# Eval H6 seed skill',
	'',
	'Used only by task H6 of the MCP eval harness. Do not edit by hand.',
	'',
	'seed-marker: eval-h6-seed-v1',
].join('\n')

export function h6Marker(ctx: Pick<TaskContext, 'sessionId'>): string {
	return `eval-marker-${ctx.sessionId}`
}

function fail(reason: string): CheckResult {
	return { passed: false, reason }
}

const pass: CheckResult = { passed: true, reason: 'ok' }

/** Exactly one object with this title and type, or a reason it is not so. */
async function expectOne(
	ctx: TaskContext,
	title: string,
	type: string,
): Promise<{ row: ObjectRow } | { reason: string }> {
	const rows = (await ctx.state.objectsByTitle(title)).filter((row) => row.type === type)
	if (rows.length === 0) return { reason: `no ${type} titled "${title}"` }
	if (rows.length > 1) return { reason: `${rows.length} ${type} objects titled "${title}"` }
	return { row: rows[0] as ObjectRow }
}

function lines(content: string | null): string[] {
	return (content ?? '')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
}

const bet: TaskDef = {
	id: 'T1-bet-with-tasks',
	title: 'Create a bet with three tasks and link them',
	heldOut: false,
	drift: 'edge source and target (create_objects, create_relationship)',
	async setup() {
		return {}
	},
	prompt(ctx) {
		return `Create a bet titled "Eval bet ${ctx.short}". Create three tasks titled "Eval task ${ctx.short} A", "Eval task ${ctx.short} B" and "Eval task ${ctx.short} C". Then link the bet to each of the three tasks so that the bet breaks into those tasks.`
	},
	async check(ctx) {
		const betResult = await expectOne(ctx, `Eval bet ${ctx.short}`, 'bet')
		if ('reason' in betResult) return fail(betResult.reason)
		const edges = await ctx.state.edgesInvolving(betResult.row.id)
		for (const letter of ['A', 'B', 'C']) {
			const taskResult = await expectOne(ctx, `Eval task ${ctx.short} ${letter}`, 'task')
			if ('reason' in taskResult) return fail(taskResult.reason)
			const linked = edges.some(
				(edge) =>
					edge.type === 'breaks_into' &&
					edge.sourceId === betResult.row.id &&
					edge.targetId === taskResult.row.id,
			)
			if (!linked) return fail(`no breaks_into edge from the bet to task ${letter}`)
		}
		return pass
	},
}

const readByIds: TaskDef = {
	id: 'T2-read-by-ids',
	title: 'Read three objects by id and copy their codes into a note',
	heldOut: false,
	drift: 'get by ids (get_objects)',
	async setup(ctx) {
		const seed: Seed = {}
		for (const n of [1, 2, 3]) {
			const code = `RC-${ctx.sessionId.slice(0, 4)}${n}${ctx.sessionId.slice(-4)}`
			const created = await ctx.seeder.createObject({
				type: 'knowledge',
				title: `Eval ref ${ctx.short} ${n}`,
				content: `Reference code: ${code}`,
			})
			seed[`id${n}`] = created.id
			seed[`code${n}`] = code
		}
		return seed
	},
	prompt(ctx, seed) {
		return `Read these three objects: ${seed.id1}, ${seed.id2} and ${seed.id3}. Each one holds a reference code in its content. Create a knowledge note titled "Eval codes ${ctx.short}" that contains the three reference codes, one per line.`
	},
	async check(ctx, seed) {
		const note = await expectOne(ctx, `Eval codes ${ctx.short}`, 'knowledge')
		if ('reason' in note) return fail(note.reason)
		const noteLines = lines(note.row.content)
		for (const n of [1, 2, 3]) {
			if (!noteLines.some((line) => line.includes(seed[`code${n}`] as string))) {
				return fail(`note is missing the code of reference ${n}`)
			}
		}
		return pass
	},
}

const setDriver: TaskDef = {
	id: 'T3-set-driver',
	title: 'Make a named agent the driver of a task',
	heldOut: false,
	drift: 'driver on update (update_objects)',
	async setup(ctx) {
		const helper = await ctx.seeder.ensureHelperAgent(HELPER_AGENT_NAME)
		const task = await ctx.seeder.createObject({
			type: 'task',
			title: `Eval assign ${ctx.short}`,
			status: 'backlog',
		})
		return { helperId: helper.id, taskId: task.id }
	},
	prompt(ctx) {
		return `Make the agent named "${HELPER_AGENT_NAME}" the driver of the task titled "Eval assign ${ctx.short}".`
	},
	async check(ctx, seed) {
		const task = await expectOne(ctx, `Eval assign ${ctx.short}`, 'task')
		if ('reason' in task) return fail(task.reason)
		if (task.row.driver !== seed.helperId) {
			return fail(`task driver is ${task.row.driver ?? 'empty'}, not the helper agent`)
		}
		return pass
	},
}

const listLinks: TaskDef = {
	id: 'T4-list-links',
	title: 'List everything connected to a bet, in either direction',
	heldOut: true,
	drift: 'relationship listing (list_relationships)',
	async setup(ctx) {
		const hub = await ctx.seeder.createObject({
			type: 'bet',
			title: `Eval hub ${ctx.short}`,
		})
		// One edge pointing at the hub, two pointing away from it, so listing by
		// only one direction misses something.
		const a = await ctx.seeder.createObject({ type: 'insight', title: `Eval link ${ctx.short} A` })
		const b = await ctx.seeder.createObject({
			type: 'knowledge',
			title: `Eval link ${ctx.short} B`,
		})
		const c = await ctx.seeder.createObject({ type: 'task', title: `Eval link ${ctx.short} C` })
		await ctx.seeder.createEdge({ sourceId: a.id, targetId: hub.id, type: 'informs' })
		await ctx.seeder.createEdge({ sourceId: hub.id, targetId: b.id, type: 'relates_to' })
		await ctx.seeder.createEdge({ sourceId: hub.id, targetId: c.id, type: 'breaks_into' })
		// Decoys that are linked to each other but not to the hub.
		const d1 = await ctx.seeder.createObject({
			type: 'insight',
			title: `Eval decoy ${ctx.short} 1`,
		})
		const d2 = await ctx.seeder.createObject({ type: 'task', title: `Eval decoy ${ctx.short} 2` })
		await ctx.seeder.createEdge({ sourceId: d1.id, targetId: d2.id, type: 'relates_to' })
		return { hubId: hub.id }
	},
	prompt(ctx, seed) {
		return `Find every object that is directly connected to the bet with id ${seed.hubId}, whichever way the connection points. Create a knowledge note titled "Eval links ${ctx.short}" that lists the titles of those connected objects, one per line.`
	},
	async check(ctx) {
		const note = await expectOne(ctx, `Eval links ${ctx.short}`, 'knowledge')
		if ('reason' in note) return fail(note.reason)
		const noteLines = lines(note.row.content)
		for (const letter of ['A', 'B', 'C']) {
			const title = `Eval link ${ctx.short} ${letter}`
			if (!noteLines.some((line) => line.includes(title))) return fail(`note is missing "${title}"`)
		}
		for (const n of [1, 2]) {
			if (noteLines.some((line) => line.includes(`Eval decoy ${ctx.short} ${n}`))) {
				return fail(`note lists decoy ${n}, which is not connected to the bet`)
			}
		}
		return pass
	},
}

const startSession: TaskDef = {
	id: 'T5-start-session',
	title: 'Start a named agent on a task without waiting for it',
	heldOut: true,
	drift: 'create_session arguments (actor, object link, prompt)',
	async setup(ctx) {
		const helper = await ctx.seeder.ensureHelperAgent(HELPER_AGENT_NAME)
		const task = await ctx.seeder.createObject({
			type: 'task',
			title: `Eval handoff ${ctx.short}`,
			status: 'backlog',
		})
		return { helperId: helper.id, taskId: task.id }
	},
	prompt(ctx) {
		return `Start the agent named "${HELPER_AGENT_NAME}" on the task titled "Eval handoff ${ctx.short}". Tell it: "eval-handoff-${ctx.short}, please look at this task." Do not wait for it to finish.`
	},
	async check(ctx, seed) {
		const sessions = await ctx.state.sessionsInitiatedFrom(seed.taskId as string)
		if (sessions.length === 0) return fail('no session was started from the task')
		const match = sessions.find(
			(session) =>
				session.actorId === seed.helperId &&
				session.actionPrompt.includes(`eval-handoff-${ctx.short}`),
		)
		if (!match) return fail('no session for the helper agent carries the instruction text')
		return pass
	},
}

const skillLookup: TaskDef = {
	id: H6_TASK_ID,
	title: 'H6: fetch a skill by id and by name, then append a line to it',
	heldOut: false,
	drift: 'skill lookup by id or name (get/update_workspace_skill)',
	async setup(ctx) {
		await ctx.seeder.putSkill(H6_SKILL_NAME, H6_SEED_CONTENT)
		// The server stores skill content with its own header block in front, so
		// "the old content" is whatever is stored once the seed is in place.
		const baseline = await ctx.state.skillContent(H6_SKILL_NAME)
		if (baseline === null) throw new Error(`seed skill ${H6_SKILL_NAME} is missing after reset`)
		return { baseline }
	},
	prompt(ctx) {
		return `List the skills in the workspace. Fetch the skill named "${H6_SKILL_NAME}" using the id shown in the list. Fetch it again using its name. Then add a new last line to its content that reads "${h6Marker(ctx)}" and save the skill.`
	},
	async check(ctx, seed, telemetry, client) {
		const stored = await ctx.state.skillContent(H6_SKILL_NAME)
		if (stored === null) return fail(`skill ${H6_SKILL_NAME} is gone`)
		const expected = `${seed.baseline}\n${h6Marker(ctx)}`
		// One trailing newline is fine; anything else must match exactly.
		if (stored.replace(/\n$/, '') !== expected) {
			return fail('stored content is not the old content plus the marker line')
		}
		const getErrors = telemetry.errorRowsByTool.get_workspace_skill ?? 0
		const updateErrors = telemetry.errorRowsByTool.update_workspace_skill ?? 0
		if (getErrors + updateErrors > 0) {
			return fail(
				`error rows in the session: get_workspace_skill ${getErrors}, update_workspace_skill ${updateErrors}`,
			)
		}
		// The prompt tells the agent to fetch by id, so a "Not found" reply on that
		// call is the failure the id-or-name change removes. It writes no error row,
		// so it is read from the agent's own tool errors. The fetch by name must
		// succeed, so any "Not found" on get_workspace_skill means the id fetch failed.
		const notFound = client.notFoundByTool.get_workspace_skill ?? 0
		if (notFound > 0) {
			return fail(`get_workspace_skill answered "Not found" ${notFound} time(s) on the fetch by id`)
		}
		return pass
	},
}

export const TASKS: TaskDef[] = [bet, readByIds, setDriver, listLinks, startSession, skillLookup]
