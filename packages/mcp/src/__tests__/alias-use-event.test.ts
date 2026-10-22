import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TelemetryConfig, TelemetryEvent } from '../telemetry'
import {
	type AliasHarness,
	DEFAULT_WORKSPACE_ID,
	isValidationError,
	startAliasHarness,
} from './helpers/alias-harness'

// See aliases.test.ts: keep the stdio entry point of ../server from listening
// on this process's stdin.
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

// The alias_use event, through a real McpServer and client: the event is emitted
// by the alias layer's normalise step, which only runs inside the SDK's argument
// validation, so a mock-based test would pass with the emitter missing.

type AliasUse = Extract<TelemetryEvent, { event_type: 'alias_use' }>
type Captured = { event: TelemetryEvent; target: TelemetryConfig }

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const OTHER_WS = '00000000-0000-4000-8000-0000000000cc'
const SECRET = 'Acquire the Nakatomi account'

describe('alias_use event through the real SDK path', () => {
	let harness: AliasHarness
	let captured: Captured[]

	beforeAll(async () => {
		captured = []
		harness = await startAliasHarness({
			telemetrySink: (event, target) => {
				captured.push({ event, target })
			},
			// A session that is already finished, so run_agent returns after one poll.
			respond: ({ method, path }) => {
				if (method === 'POST' && path === '/api/sessions') return { id: 's1', status: 'pending' }
				if (method === 'GET' && path === '/api/sessions/s1')
					return { id: 's1', status: 'completed' }
				if (path.startsWith('/api/sessions/s1/logs')) return []
				return undefined
			},
		})
	})
	afterAll(async () => {
		await harness.close()
	})

	const aliasUses = () =>
		captured.filter((c) => c.event.event_type === 'alias_use') as Array<{
			event: AliasUse
			target: TelemetryConfig
		}>
	const callAndCapture = async (name: string, args: Record<string, unknown>) => {
		captured.length = 0
		const outcome = await harness.call(name, args)
		return { outcome, uses: aliasUses() }
	}

	it('emits one event for a call that used an old name, with the renames and nothing else', async () => {
		const { outcome, uses } = await callAndCapture('list_objects', {
			workspace_id: DEFAULT_WORKSPACE_ID,
			driver_id: U1,
		})

		expect(outcome.isError).toBe(false)
		expect(uses).toHaveLength(1)
		expect(uses[0].event).toMatchObject({
			event_type: 'alias_use',
			tool_name: 'list_objects',
			renames: [{ old: 'driver_id', new: 'driver' }],
			both_sent: false,
		})
	})

	it('emits nothing for a call that used only canonical names', async () => {
		const { outcome, uses } = await callAndCapture('list_objects', {
			workspace_id: DEFAULT_WORKSPACE_ID,
			driver: U1,
		})

		expect(outcome.isError).toBe(false)
		expect(uses).toHaveLength(0)
	})

	it('emits one event per call, however many old names the call used', async () => {
		const { uses } = await callAndCapture('create_objects', {
			workspace_id: DEFAULT_WORKSPACE_ID,
			nodes: [{ $id: 'a', type: 'task', status: 'todo', title: SECRET, driver_id: U1 }],
			edges: [{ source_id: 'a', target_id: U2, type: 'relates_to' }],
		})

		expect(uses).toHaveLength(1)
		expect(uses[0].event.renames.map((r) => r.old).sort()).toEqual([
			'edges.source_id',
			'edges.target_id',
			'nodes.driver_id',
		])
	})

	it('puts key names only in the event, never a value', async () => {
		const { uses } = await callAndCapture('create_objects', {
			workspace_id: DEFAULT_WORKSPACE_ID,
			nodes: [{ $id: 'a', type: 'task', status: 'todo', title: SECRET, driver_id: U1 }],
		})

		const serialised = JSON.stringify(uses[0].event)
		expect(serialised).not.toContain(SECRET)
		expect(serialised).not.toContain(U1)
		expect(serialised).not.toContain(DEFAULT_WORKSPACE_ID)
	})

	it('still emits when validation then fails', async () => {
		// id wraps to ids, and a non-uuid id then fails validation.
		const { outcome, uses } = await callAndCapture('get_objects', {
			workspace_id: DEFAULT_WORKSPACE_ID,
			id: 'not-a-uuid',
		})

		expect(isValidationError(outcome)).toBe(true)
		expect(uses).toHaveLength(1)
		expect(uses[0].event).toMatchObject({
			tool_name: 'get_objects',
			renames: [{ old: 'id', new: 'ids' }],
		})
	})

	it('flags both_sent when the old and the new spelling arrive together', async () => {
		const { uses } = await callAndCapture('list_objects', {
			workspace_id: DEFAULT_WORKSPACE_ID,
			driver_id: U1,
			driver: U2,
		})

		expect(uses).toHaveLength(1)
		expect(uses[0].event.both_sent).toBe(true)
		expect(JSON.stringify(uses[0].event)).not.toContain(U2)
	})

	it("uses the call's workspace_id argument, else the default", async () => {
		const withArg = await callAndCapture('list_objects', { workspace_id: OTHER_WS, driver_id: U1 })
		const withoutArg = await callAndCapture('list_objects', { driver_id: U1 })

		expect(withArg.uses[0].target.workspaceId).toBe(OTHER_WS)
		expect(withoutArg.uses[0].target.workspaceId).toBe(DEFAULT_WORKSPACE_ID)
	})

	it('does not add a tool_call of its own: the alias event is a separate event type', async () => {
		const { outcome } = await callAndCapture('list_objects', {
			workspace_id: DEFAULT_WORKSPACE_ID,
			driver_id: U1,
		})

		expect(outcome.isError).toBe(false)
		expect(captured.filter((c) => c.event.event_type === 'tool_call')).toHaveLength(1)
		expect(captured.filter((c) => c.event.event_type === 'alias_use')).toHaveLength(1)
	})

	describe('run_agent', () => {
		const legacyCall = {
			actor_id: U1,
			action_prompt: SECRET,
			config: { runtime: 'codex' },
			poll_interval_seconds: 5,
			timeout_seconds: 120,
			depends_on_session_ids: [U2],
		}

		it('is listed in tools/list with a one line deprecated description', async () => {
			const listed = (await harness.listTools()) as Array<{ name: string; description?: string }>
			const entry = listed.find((t) => t.name === 'run_agent')

			expect(entry?.description).toBe('Deprecated, use create_session with wait true.')
			expect(listed.some((t) => t.name === 'create_session')).toBe(true)
		})

		it('lists only the minimal parameters, not the ones it drops', async () => {
			const listed = await harness.listTools()
			const schema = listed.find((t) => t.name === 'run_agent')?.inputSchema as {
				properties: Record<string, unknown>
				required?: string[]
			}

			expect(Object.keys(schema.properties).sort()).toEqual([
				'action_prompt',
				'actor_id',
				'spawned_by_message_id',
				'workspace_id',
			])
			expect(schema.required?.sort()).toEqual(['action_prompt', 'actor_id'])
		})

		it(
			'creates a session, returns create_session-with-wait shaped output, and records one alias_use',
			{ timeout: 20_000 },
			async () => {
				const { outcome, uses } = await callAndCapture('run_agent', legacyCall)

				expect(outcome.isError).toBe(false)
				const parsed = JSON.parse(outcome.text)
				expect(parsed).toMatchObject({ session_id: 's1', settled: true, logs: [] })

				const create = outcome.requests.find(
					(r) => r.method === 'POST' && r.path === '/api/sessions',
				)
				expect(create?.body).toMatchObject({ actor_id: U1, action_prompt: SECRET })
				expect(create?.workspace).toBe(DEFAULT_WORKSPACE_ID)
				for (const dropped of [
					'config',
					'poll_interval_seconds',
					'timeout_seconds',
					'depends_on_session_ids',
				]) {
					expect(create?.body).not.toHaveProperty(dropped)
				}

				expect(uses).toHaveLength(1)
				expect(uses[0].event).toMatchObject({
					tool_name: 'run_agent',
					renames: [],
					both_sent: false,
					dropped_keys: [
						'config',
						'poll_interval_seconds',
						'timeout_seconds',
						'depends_on_session_ids',
					],
					tool_alias: { old: 'run_agent', new: 'create_session' },
				})
				expect(captured.filter((c) => c.event.event_type === 'tool_call')).toHaveLength(1)
				const serialised = JSON.stringify(uses[0].event)
				expect(serialised).not.toContain(SECRET)
				expect(serialised).not.toContain('codex')
			},
		)

		it('still records the use when validation then fails', async () => {
			const { outcome, uses } = await callAndCapture('run_agent', {
				actor_id: 'not-a-uuid',
				action_prompt: 'x',
				config: {},
			})

			expect(isValidationError(outcome)).toBe(true)
			expect(uses).toHaveLength(1)
			expect(uses[0].event.dropped_keys).toEqual(['config'])
		})
	})
})
