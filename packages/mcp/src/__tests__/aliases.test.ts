import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { normaliseArgs } from '../alias-layer'
import { ALIASES, DEFAULT_WORKSPACE_TOOLS } from '../aliases'
import { tools } from '../tools'
import {
	type AliasHarness,
	DEFAULT_WORKSPACE_ID,
	ROW_SCENARIOS,
	isValidationError,
	startAliasHarness,
} from './helpers/alias-harness'

// Importing ../server runs its stdio entry point, which would listen on this
// process's stdin. The harness builds its own server and talks over an
// in-memory transport, so the stdio one is replaced with an inert stand-in.
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
	StdioServerTransport: class {
		onmessage?: unknown
		onclose?: unknown
		onerror?: unknown
		async start() {}
		async send() {}
		async close() {}
	},
}))

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'

describe('normaliseArgs', () => {
	it('renames a top-level key and reports it', () => {
		const result = normaliseArgs('list_objects', { driver_id: U1 })
		expect(result.args).toEqual({ driver: U1 })
		expect(result.renames).toEqual([{ old: 'driver_id', new: 'driver' }])
		expect(result.bothSent).toBe(false)
	})

	it('renames a nested key on every element of an array, reported once', () => {
		const result = normaliseArgs('create_objects', {
			edges: [
				{ source_id: 'a', target_id: U1, type: 'relates_to' },
				{ source_id: 'b', target_id: U2, type: 'relates_to' },
			],
		})
		expect(result.args).toEqual({
			edges: [
				{ source: 'a', target: U1, type: 'relates_to' },
				{ source: 'b', target: U2, type: 'relates_to' },
			],
		})
		expect(result.renames).toEqual([
			{ old: 'edges.source_id', new: 'edges.source' },
			{ old: 'edges.target_id', new: 'edges.target' },
		])
	})

	it('applies a nested rename to the object at the path', () => {
		// No tool has an object-valued parameter with an alias yet, so the rows are
		// passed in. This pins the dotted-path behaviour for the first one that does.
		const rows = [
			{ tool: 'any', oldPath: 'config.maxTurns', newPath: 'config.max_turns', kind: 'nested' },
		] as const
		const result = normaliseArgs('any', { config: { maxTurns: 5, other: 1 } }, { rows })
		expect(result.args).toEqual({ config: { max_turns: 5, other: 1 } })
		expect(result.renames).toEqual([{ old: 'config.maxTurns', new: 'config.max_turns' }])
	})

	it('leaves a nested path alone when the parent is missing or not an object', () => {
		const rows = [
			{ tool: 'any', oldPath: 'config.maxTurns', newPath: 'config.max_turns', kind: 'nested' },
		] as const
		expect(normaliseArgs('any', { other: 1 }, { rows }).args).toEqual({ other: 1 })
		expect(normaliseArgs('any', { config: 'x' }, { rows }).args).toEqual({ config: 'x' })
		expect(normaliseArgs('any', { config: null }, { rows }).args).toEqual({ config: null })
	})

	it('wraps a scalar into a one-element array', () => {
		const result = normaliseArgs('get_objects', { id: U1 })
		expect(result.args).toEqual({ ids: [U1] })
		expect(result.renames).toEqual([{ old: 'id', new: 'ids' }])
	})

	it('leaves an array sent under the old wrap key as it is', () => {
		expect(normaliseArgs('get_objects', { id: [U1, U2] }).args).toEqual({ ids: [U1, U2] })
	})

	it('lets the new key win when both spellings are sent, and says so', () => {
		const result = normaliseArgs('list_objects', { driver_id: U1, driver: U2 })
		expect(result.args).toEqual({ driver: U2 })
		expect(result.bothSent).toBe(true)
		expect(result.renames).toEqual([{ old: 'driver_id', new: 'driver' }])
	})

	it('keeps the new key when both are sent on a wrap row', () => {
		const result = normaliseArgs('get_objects', { id: U1, ids: [U2] })
		expect(result.args).toEqual({ ids: [U2] })
		expect(result.bothSent).toBe(true)
	})

	it('leaves unknown keys alone for the schema to strip', () => {
		const result = normaliseArgs('list_objects', { driver_id: U1, nonsense: 1 })
		expect(result.args).toEqual({ driver: U1, nonsense: 1 })
	})

	it('does not change the caller arguments', () => {
		const input = { edges: [{ source_id: 'a', target_id: U1, type: 'relates_to' }] }
		const copy = structuredClone(input)
		normaliseArgs('create_objects', input)
		expect(input).toEqual(copy)
	})

	it('returns the same arguments for a tool with no rows', () => {
		const input = { content: 'x' }
		const result = normaliseArgs('create_comment', input)
		expect(result.args).toBe(input)
		expect(result.renames).toEqual([])
		expect(result.bothSent).toBe(false)
	})

	it('passes arguments that are not an object through untouched', () => {
		expect(normaliseArgs('get_objects', undefined).args).toBeUndefined()
		expect(normaliseArgs('get_objects', 'x').args).toBe('x')
	})

	describe('default workspace', () => {
		it.each([...DEFAULT_WORKSPACE_TOOLS])(
			'fills workspace_id on %s when it is left out',
			(tool) => {
				const result = normaliseArgs(tool, {}, { defaultWorkspaceId: DEFAULT_WORKSPACE_ID })
				expect(result.args).toEqual({ workspace_id: DEFAULT_WORKSPACE_ID })
				// A relaxation, not an alias: it is never reported as a rename.
				expect(result.renames).toEqual([])
			},
		)

		it('keeps a workspace_id the caller sent', () => {
			const result = normaliseArgs(
				'list_objects',
				{ workspace_id: U1 },
				{ defaultWorkspaceId: DEFAULT_WORKSPACE_ID },
			)
			expect(result.args).toEqual({ workspace_id: U1 })
		})

		it('does nothing when the connection has no default workspace', () => {
			expect(normaliseArgs('list_objects', {}, { defaultWorkspaceId: '' }).args).toEqual({})
		})

		it('does not touch tools outside the three', () => {
			const result = normaliseArgs(
				'create_session',
				{},
				{ defaultWorkspaceId: DEFAULT_WORKSPACE_ID },
			)
			expect(result.args).toEqual({})
		})
	})
})

describe('alias table', () => {
	let harness: AliasHarness
	let listed: Map<string, { name: string; inputSchema: unknown }>

	beforeAll(async () => {
		harness = await startAliasHarness()
		listed = new Map((await harness.listTools()).map((t) => [t.name, t]))
	})
	afterAll(async () => {
		await harness.close()
	})

	const advertised = (tool: string): Set<string> => {
		const paths = new Set<string>()
		const walk = (node: unknown, prefix: string) => {
			if (!node || typeof node !== 'object') return
			const schema = node as Record<string, unknown>
			for (const [key, child] of Object.entries(
				(schema.properties as Record<string, unknown>) ?? {},
			)) {
				const path = prefix ? `${prefix}.${key}` : key
				paths.add(path)
				walk(child, path)
			}
			walk(schema.items, prefix)
		}
		walk(listed.get(tool)?.inputSchema, '')
		return paths
	}

	it.each(ALIASES.map((row) => [`${row.tool} ${row.oldPath}`, row] as const))(
		'%s: the tool is listed with the new name and without the old one',
		(_label, row) => {
			expect(listed.has(row.tool)).toBe(true)
			const paths = advertised(row.tool)
			expect(paths.has(row.newPath)).toBe(true)
			expect(paths.has(row.oldPath)).toBe(false)
		},
	)

	it('keeps each row inside one object: old and new share a parent', () => {
		for (const row of ALIASES) {
			const parent = (p: string) => p.split('.').slice(0, -1).join('.')
			expect(parent(row.oldPath), `${row.tool} ${row.oldPath}`).toBe(parent(row.newPath))
		}
	})

	it('names the kind that matches the path', () => {
		for (const row of ALIASES) {
			if (row.kind === 'nested') expect(row.oldPath).toContain('.')
			else expect(row.oldPath).not.toContain('.')
		}
	})

	it('has no two rows for the same tool and old path', () => {
		const keys = ALIASES.map((r) => `${r.tool} ${r.oldPath}`)
		expect(new Set(keys).size).toBe(keys.length)
	})

	it('has the four misfire rows, each a rename to the name the tool advertises', () => {
		for (const [tool, oldPath, newPath] of [
			['get_comments', 'object_id', 'entity_id'],
			['search_objects', 'query', 'q'],
			['get_session', 'session_id', 'id'],
			['get_actor', 'actor_id', 'id'],
		]) {
			expect(ALIASES).toContainEqual({ tool, oldPath, newPath, kind: 'rename' })
		}
	})

	it('has the three skill rows, id to name', () => {
		for (const tool of [
			'get_workspace_skill',
			'update_workspace_skill',
			'delete_workspace_skill',
		]) {
			expect(ALIASES).toContainEqual({ tool, oldPath: 'id', newPath: 'name', kind: 'rename' })
		}
	})

	it('covers every row with a through-the-SDK scenario', () => {
		const covered = new Set(ROW_SCENARIOS.flatMap((s) => s.covers))
		const rows = ALIASES.map((r) => `${r.tool} ${r.oldPath}`)
		expect(rows.filter((r) => !covered.has(r))).toEqual([])
		expect([...covered].filter((c) => !rows.includes(c))).toEqual([])
	})

	it('has a kind of each type in the table', () => {
		expect(new Set(ALIASES.map((r) => r.kind))).toEqual(new Set(['rename', 'wrap', 'nested']))
	})
})

// Everything below goes through a real McpServer and a real MCP client. If the
// preprocess wrapper were removed from the registration wrapper in server.ts,
// each scenario here fails: the old spelling is rejected before the handler.
describe('through the real SDK path', () => {
	let harness: AliasHarness

	beforeAll(async () => {
		harness = await startAliasHarness()
	})
	afterAll(async () => {
		await harness.close()
	})

	describe.each(ROW_SCENARIOS.map((s) => [s.covers.join(' + '), s] as const))(
		'%s',
		(_label, sc) => {
			it('is accepted, not rejected as an invalid argument', async () => {
				expect(isValidationError(await harness.call(sc.tool, sc.old))).toBe(false)
			})

			it('gives the same result as the canonical spelling', async () => {
				const old = await harness.call(sc.tool, sc.old)
				const canonical = await harness.call(sc.tool, sc.canonical)
				expect(old).toEqual(canonical)
			})

			it('sends the value upstream, it is not silently dropped', async () => {
				const old = await harness.call(sc.tool, sc.old)
				const control = await harness.call(sc.tool, sc.control)
				expect(old.requests.length).toBeGreaterThan(0)
				expect(old.requests).not.toEqual(control.requests)
			})
		},
	)

	it('wrap: an id sent to get_objects is fetched as a one-element ids list', async () => {
		const outcome = await harness.call('get_objects', { id: U1 })
		expect(isValidationError(outcome)).toBe(false)
		expect(outcome.requests.some((r) => r.path.includes(`/api/objects/${U1}/graph`))).toBe(true)
	})

	it('conflict: new spelling wins and the old value is dropped', async () => {
		const both = await harness.call('get_objects', { id: U1, ids: [U2] })
		const onlyNew = await harness.call('get_objects', { ids: [U2] })
		expect(both).toEqual(onlyNew)
		expect(both.requests.some((r) => r.path.includes(U1))).toBe(false)
	})

	it('conflict: on get_comments the canonical entity_id wins over object_id', async () => {
		const both = await harness.call('get_comments', { object_id: U1, entity_id: U2 })
		const onlyNew = await harness.call('get_comments', { entity_id: U2 })
		expect(isValidationError(both)).toBe(false)
		expect(both).toEqual(onlyNew)
		expect(both.requests.some((r) => r.path.includes(U1))).toBe(false)
		expect(both.requests.some((r) => r.path.includes(U2))).toBe(true)
	})

	it('unknown keys are still stripped, not rejected', async () => {
		const withJunk = await harness.call('get_objects', { ids: [U1], nonsense: true })
		const clean = await harness.call('get_objects', { ids: [U1] })
		expect(withJunk).toEqual(clean)
	})

	it('a required field still has to be there', async () => {
		expect(isValidationError(await harness.call('get_objects', {}))).toBe(true)
	})

	it('workspace_id: falls back to the default on create_objects and list_objects', async () => {
		const created = await harness.call('create_objects', {
			nodes: [{ $id: 'a', type: 'task', status: 'todo', title: 'A task' }],
		})
		expect(isValidationError(created)).toBe(false)
		expect(created.requests.every((r) => r.workspace === DEFAULT_WORKSPACE_ID)).toBe(true)
		expect(isValidationError(await harness.call('list_objects', {}))).toBe(false)
	})

	it('workspace_id: falls back to the default on create_loop', async () => {
		const outcome = await harness.call('create_loop', {
			name: 'A loop',
			steps: [{ name: 'Step', agent_id: U1, prompt: 'Go', when: { cron: '0 9 * * *' } }],
		})
		// The call fails further in (the agent does not exist). It must get past
		// argument validation without a workspace_id.
		expect(isValidationError(outcome)).toBe(false)
	})
})

describe('tools/list', () => {
	let harness: AliasHarness

	beforeAll(async () => {
		harness = await startAliasHarness()
	})
	afterAll(async () => {
		await harness.close()
	})

	it('advertises exactly the canonical schema for every wrapped tool', async () => {
		const listed = new Map((await harness.listTools()).map((t) => [t.name, t.inputSchema]))
		const wrapped = new Set([...ALIASES.map((r) => r.tool), ...DEFAULT_WORKSPACE_TOOLS])
		expect(wrapped.size).toBeGreaterThan(0)
		for (const name of wrapped) {
			const canonical = tools[name as keyof typeof tools]
			expect(canonical, name).toBeDefined()
			const expected = toJsonSchemaCompat(z.object(canonical.inputSchema.shape), {
				strictUnions: true,
				pipeStrategy: 'input',
			})
			expect(listed.get(name), name).toEqual(expected)
		}
	})

	it('keeps workspace_id required where it is required today', async () => {
		const listed = new Map((await harness.listTools()).map((t) => [t.name, t.inputSchema]))
		for (const name of DEFAULT_WORKSPACE_TOOLS) {
			const schema = listed.get(name) as { required?: string[] }
			expect(schema.required, name).toContain('workspace_id')
		}
	})
})
