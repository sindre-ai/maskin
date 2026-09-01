import { describe, expect, it } from 'vitest'
import {
	type GrantRow,
	type KnownTool,
	allowedIntegrationRefs,
	resolveGrantsForAgent,
} from '../../lib/tool-grants/resolve'

const AGENT = 'actor-1'
const REF = 'w0123_linear'

const grant = (over: Partial<GrantRow> = {}): GrantRow => ({
	actorId: AGENT,
	integrationRef: REF,
	mode: 'all',
	tools: [],
	...over,
})

// Shaped like a real tool list: most tools declare readOnlyHint, a few do not.
const TOOLS: KnownTool[] = [
	{ name: 'list_issues', readOnly: true },
	{ name: 'get_issue', readOnly: true },
	{ name: 'create_issue', readOnly: false },
	{ name: 'delete_issue', readOnly: false },
	{ name: 'run_workflow', readOnly: null },
]

const known = new Map([[REF, TOOLS]])

describe('resolveGrantsForAgent', () => {
	it('gives nothing when the agent has no grant', () => {
		// The default is deny — a workspace row alone must not grant anything, or
		// connecting an integration would silently arm every agent again.
		expect(resolveGrantsForAgent([grant({ actorId: null })], known)).toEqual([])
	})

	it('gives every tool for an `all` grant', () => {
		const [g] = resolveGrantsForAgent([grant()], known)
		expect(g?.mode).toBe('all')
		// Empty list with mode `all` means unbounded, NOT "no tools" — including
		// tools we have not listed yet.
		expect(g?.tools).toEqual([])
	})

	it('gives only declared read-only tools for a `read` grant', () => {
		const [g] = resolveGrantsForAgent([grant({ mode: 'read' })], known)
		expect(g?.tools).toEqual(['list_issues', 'get_issue'])
	})

	it('leaves an undeclared tool out of a read grant', () => {
		// `run_workflow` does not say whether it writes. Sweeping it in would make
		// "Read only" a claim we cannot support.
		const [g] = resolveGrantsForAgent([grant({ mode: 'read' })], known)
		expect(g?.tools).not.toContain('run_workflow')
	})

	it('gives exactly the chosen tools for a `custom` grant', () => {
		const [g] = resolveGrantsForAgent(
			[grant({ mode: 'custom', tools: ['get_issue', 'create_issue'] })],
			known,
		)
		expect(g?.tools).toEqual(['get_issue', 'create_issue'])
	})

	it('fails closed when a read grant has no tool list to work from', () => {
		// Nothing known about this integration yet. Resolving to "everything" would
		// hand over write tools under a read-only label.
		expect(resolveGrantsForAgent([grant({ mode: 'read' })], new Map())).toEqual([])
	})
})

describe('the workspace row as a ceiling', () => {
	it('narrows an agent `all` grant to the workspace list', () => {
		const [g] = resolveGrantsForAgent(
			[grant(), grant({ actorId: null, mode: 'custom', tools: ['get_issue'] })],
			known,
		)
		expect(g?.tools).toEqual(['get_issue'])
	})

	it('intersects two explicit lists rather than taking either side', () => {
		const [g] = resolveGrantsForAgent(
			[
				grant({ mode: 'custom', tools: ['get_issue', 'create_issue'] }),
				grant({ actorId: null, mode: 'custom', tools: ['create_issue', 'delete_issue'] }),
			],
			known,
		)
		expect(g?.tools).toEqual(['create_issue'])
	})

	it('lets an agent be narrower than the ceiling', () => {
		const [g] = resolveGrantsForAgent(
			[grant({ mode: 'custom', tools: ['get_issue'] }), grant({ actorId: null, mode: 'all' })],
			known,
		)
		expect(g?.tools).toEqual(['get_issue'])
	})

	it('drops the integration when the ceiling excludes everything the agent has', () => {
		// An integration that resolves to no callable tools is worse than absent:
		// it appears granted and fails on use.
		expect(
			resolveGrantsForAgent(
				[
					grant({ mode: 'custom', tools: ['delete_issue'] }),
					grant({ actorId: null, mode: 'read' }),
				],
				known,
			),
		).toEqual([])
	})

	it('a workspace read ceiling clamps an agent all grant to read', () => {
		const [g] = resolveGrantsForAgent([grant(), grant({ actorId: null, mode: 'read' })], known)
		expect(g?.tools).toEqual(['list_issues', 'get_issue'])
	})
})

describe('allowedIntegrationRefs', () => {
	it('lists what the session launch may inject', () => {
		const resolved = resolveGrantsForAgent(
			[grant(), grant({ integrationRef: 'github-acme' })],
			known,
		)
		expect(allowedIntegrationRefs(resolved)).toEqual(new Set([REF, 'github-acme']))
	})

	it('excludes an integration the agent was never granted', () => {
		const resolved = resolveGrantsForAgent([grant()], known)
		expect(allowedIntegrationRefs(resolved).has('integration-slack')).toBe(false)
	})
})
