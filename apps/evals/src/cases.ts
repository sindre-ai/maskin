import type { Trajectory } from './agent'
import type { Fixture } from './fixture'
import type { ToolName } from './tools'

/**
 * Returns null when the arguments are acceptable, or a short human-readable
 * reason when they are not. Reasons land in the report verbatim, so write them
 * as the sentence you would want to read at 2am: what was expected, what came.
 */
export type ArgCheck = (input: Record<string, unknown>) => string | null

/**
 * Same contract as ArgCheck, one level up: null to pass, else the sentence.
 * Gets the whole trajectory *and* the fixture, so an assertion can read the
 * workspace back rather than trusting what the transcript claims happened.
 */
export type TrajectoryCheck = (
	trajectory: Trajectory,
	fixture: Fixture,
) => Promise<string | null> | string | null

interface BaseCase {
	id: string
	/** What behaviour this case pins down, in one line. Shown in the report. */
	intent: string
	prompt: string
}

/**
 * One graded turn. Cheap, hermetic, no server involved: the model is shown the
 * tool definitions and we look at the first call it reaches for. This measures
 * routing - does the description send it to the right place.
 */
export interface RoutingCase extends BaseCase {
	kind: 'routing'
	/** The tool the model must call, or null when it must answer without tools. */
	expectTool: ToolName | null
	/** Optional second gate: the call reached the right tool with usable arguments. */
	expectArgs?: ArgCheck
}

/**
 * A whole task, executed for real against a running stack in a throwaway
 * workspace. This measures whether the model can *build* the thing, which no
 * amount of single-turn routing coverage can tell you.
 */
export interface TrajectoryCase extends BaseCase {
	kind: 'trajectory'
	/** Assistant turns before the attempt is called a non-finish. */
	maxTurns: number
	/** Asserts the end state. Prefer reading the workspace over the transcript. */
	expect: TrajectoryCheck
}

export type EvalCase = RoutingCase | TrajectoryCase

const str = (input: Record<string, unknown>, key: string): string =>
	typeof input[key] === 'string' ? (input[key] as string) : ''

export const CASES: EvalCase[] = [
	// --- search vs list: the pair that actually gets confused ---
	{
		kind: 'routing',
		id: 'search-by-keyword',
		intent: 'A keyword in the ask routes to search_objects, not a list-then-filter walk',
		prompt: 'Find anything we have written about onboarding drop-off.',
		expectTool: 'search_objects',
		expectArgs: (input) => {
			const q = str(input, 'q').toLowerCase()
			if (!q) return 'no query passed in `q`'
			return q.includes('onboarding') || q.includes('drop')
				? null
				: `query "${q}" carries neither "onboarding" nor "drop"`
		},
	},
	{
		kind: 'routing',
		id: 'list-by-filter-only',
		intent: 'A pure type+status filter routes to list_objects, not a keywordless search',
		prompt: 'Show me every task that is still open.',
		expectTool: 'list_objects',
		expectArgs: (input) =>
			'q' in input ? 'passed a `q` to list_objects, which has no text-search parameter' : null,
	},

	// --- get vs list: an ID in hand should never become a listing ---
	{
		kind: 'routing',
		id: 'get-by-id',
		intent: 'An explicit UUID routes to get_objects rather than a list-and-scan',
		prompt:
			'What is the current status of object 4f1c2a90-2c3d-4b1e-9f7a-1e2d3c4b5a60? Just the status.',
		expectTool: 'get_objects',
		expectArgs: (input) => {
			const ids = Array.isArray(input.ids) ? (input.ids as unknown[]) : []
			return ids.includes('4f1c2a90-2c3d-4b1e-9f7a-1e2d3c4b5a60')
				? null
				: `ids ${JSON.stringify(ids)} does not contain the UUID from the prompt`
		},
	},
	{
		kind: 'routing',
		id: 'get-body-content',
		intent: 'Asking for an object body opts into the `content` block instead of a bare fetch',
		prompt:
			'Read me the full write-up on object 4f1c2a90-2c3d-4b1e-9f7a-1e2d3c4b5a60 - I want the body text, not a summary.',
		expectTool: 'get_objects',
		expectArgs: (input) => {
			const include = Array.isArray(input.include) ? (input.include as unknown[]) : []
			return include.includes('content')
				? null
				: `include ${JSON.stringify(include)} omits "content", so the body would not come back`
		},
	},

	// --- writes ---
	{
		kind: 'routing',
		id: 'create-task',
		intent: 'A plain "add a task" creates rather than searching for an existing one',
		prompt: 'Add a task to rewrite the billing FAQ before the end of the month.',
		expectTool: 'create_objects',
		expectArgs: (input) => {
			const objects = Array.isArray(input.objects)
				? (input.objects as Record<string, unknown>[])
				: []
			const obj = objects[0]
			if (objects.length !== 1 || !obj) {
				return `expected exactly one object, got ${objects.length}`
			}
			if (obj.type !== 'task') return `type is ${JSON.stringify(obj.type)}, expected "task"`
			return str(obj, 'title').trim() ? null : 'object has no title'
		},
	},
	{
		kind: 'routing',
		id: 'update-status',
		intent: 'A status change on a known ID updates in place instead of creating a duplicate',
		prompt:
			'Mark object 4f1c2a90-2c3d-4b1e-9f7a-1e2d3c4b5a60 as done - we shipped it this morning.',
		expectTool: 'update_objects',
		expectArgs: (input) => {
			const updates = Array.isArray(input.updates)
				? (input.updates as Record<string, unknown>[])
				: []
			return updates.some((u) => u.id === '4f1c2a90-2c3d-4b1e-9f7a-1e2d3c4b5a60')
				? null
				: 'no update entry targets the UUID from the prompt'
		},
	},

	// --- schema-before-metadata: the discovery step that gets skipped ---
	{
		kind: 'routing',
		id: 'schema-before-custom-field',
		intent: 'A custom field name is looked up in the schema before it is written blind',
		prompt:
			'Set the "promotion mode" field on our bets to human_approved. Check what values that field accepts first.',
		expectTool: 'get_workspace_schema',
	},

	// --- negative: not every turn is a tool call ---
	{
		kind: 'routing',
		id: 'no-tool-for-explanation',
		intent: 'A question about how the product works is answered, not searched for',
		prompt:
			'In one sentence: what is the difference between a bet and a task in this system? Answer from what you already know - do not look anything up.',
		expectTool: null,
	},
	{
		kind: 'routing',
		id: 'no-tool-for-ack',
		intent: 'A bare acknowledgement does not trigger a speculative read',
		prompt: 'Thanks, that is all for now.',
		expectTool: null,
	},

	// --- trajectory: the core workflow, built for real against a live stack ---
	{
		kind: 'trajectory',
		id: 'create-loop-end-to-end',
		intent: 'Asking for a loop produces a loop with steps wired to agents that exist',
		prompt:
			'Set up a loop that reviews new customer feedback every morning and turns anything ' +
			'urgent into a task for us to pick up. Build it out - do not just describe it.',
		maxTurns: 14,
		expect: async (_trajectory, fixture) => {
			const [agents, loops] = await Promise.all([fixture.agents(), fixture.loops()])

			// Ordering is forced by the product: a loop step carries an agent_id
			// that must already resolve to an agent actor, so no agents means
			// either the model skipped that step or the loop has nothing to run it.
			if (agents.length === 0) return 'no agent actor was created in the workspace'

			const loop = loops[0]
			if (loops.length === 0 || !loop) return 'no loop object exists in the workspace'
			if (loops.length > 1) {
				const names = loops.map((l) => l.name).join(', ')
				return `${loops.length} loops were created for one request: ${names}`
			}

			// The wiring assertion, and the reason this is not a tool-name check.
			// `metadata.trigger_ids` is free-form and the DB never validates it, so
			// a loop can exist, read as complete, and drive nothing at all.
			// `agentIds` is the resolved traversal loop -> trigger.target_actor_id
			// -> actor, which is what would actually run.
			if (loop.triggerIds.length === 0) {
				return `loop "${loop.name}" has no steps, so nothing would ever fire`
			}
			if (loop.agentIds.length === 0) {
				return `loop "${loop.name}" has ${loop.triggerIds.length} step(s) but no reachable agent`
			}

			// The workspace started empty, so every agent in it was created during
			// this attempt. An agent id on the loop that is not a member means a
			// step points at something outside the workspace.
			const known = new Set(agents.map((a) => a.id))
			const stray = loop.agentIds.filter((id) => !known.has(id))
			if (stray.length > 0) {
				return `loop steps reference agent(s) ${stray.join(', ')} that are not in this workspace`
			}

			return null
		},
	},
]
