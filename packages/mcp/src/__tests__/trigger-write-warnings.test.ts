import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type AliasHarness, startAliasHarness } from './helpers/alias-harness'

// Importing ../server runs its stdio entry point; the harness builds its own
// server over an in-memory transport, so the stdio one is an inert stand-in.
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

const AGENT = '11111111-1111-4111-8111-111111111111'
const HOURLY = '22222222-2222-4222-8222-222222222222'
const NEW = '33333333-3333-4333-8333-333333333333'

const base = {
	id: NEW,
	name: 'Call Hans',
	targetActorId: AGENT,
	enabled: true,
	actionPrompt: 'Call Hans. Stop when he has picked up.',
	createdAt: '2026-11-11T07:00:00.000Z',
}

describe('create_trigger and update_trigger warnings over the real MCP transport', () => {
	let harness: AliasHarness
	let saved: Record<string, unknown> = {}

	beforeAll(async () => {
		harness = await startAliasHarness({
			respond: ({ method, path }) => {
				if (path.startsWith('/api/actors')) return [{ id: AGENT, name: 'Rune Værk' }]
				if (method === 'GET' && path.startsWith('/api/triggers')) {
					return [
						{
							id: HOURLY,
							name: 'Calling run',
							type: 'cron',
							enabled: true,
							config: { expression: '0 * * * *' },
							targetActorId: AGENT,
						},
						saved,
					]
				}
				return saved
			},
		})
	})

	afterAll(async () => {
		await harness.close()
	})

	it('answers a one-time create with the saved trigger and a warning that names the hourly one', async () => {
		saved = {
			...base,
			type: 'reminder',
			config: { scheduled_at: '2030-11-12T09:00:00.000Z' },
		}
		const outcome = await harness.call('create_trigger', {
			name: 'Call Hans',
			type: 'reminder',
			config: { scheduled_at: '2030-11-12T09:00:00.000Z' },
			action_prompt: String(base.actionPrompt),
			target_actor_id: AGENT,
		})
		expect(outcome.isError).toBe(false)
		const result = JSON.parse(outcome.text) as {
			trigger: Record<string, unknown>
			warnings: Array<{ code: string; trigger_id?: string }>
		}
		expect(result.trigger).toMatchObject({
			id: NEW,
			status: 'enabled',
			kind: 'one-time',
			agent: { id: AGENT, name: 'Rune Værk' },
		})
		expect(result.trigger).not.toHaveProperty('actionPrompt')
		expect(result.warnings).toEqual([
			expect.objectContaining({ code: 'similar_trigger_exists', trigger_id: HOURLY }),
		])
		// It was saved: the POST went out before any warning check.
		expect(outcome.requests.some((r) => r.method === 'POST' && r.path === '/api/triggers')).toBe(
			true,
		)
	})

	it('warns only about what an update touched', async () => {
		saved = { ...base, type: 'cron', config: { expression: '0 9 10 11 *' }, actionPrompt: 'Call.' }
		const enable = await harness.call('update_trigger', { id: NEW, enabled: true })
		const enabled = JSON.parse(enable.text) as { warnings: Array<{ code: string }> }
		expect(enabled.warnings.map((w) => w.code)).toEqual(['similar_trigger_exists'])

		const reschedule = await harness.call('update_trigger', {
			id: NEW,
			config: { expression: '0 9 10 11 *' },
		})
		const rescheduled = JSON.parse(reschedule.text) as { warnings: Array<{ code: string }> }
		expect(rescheduled.warnings.map((w) => w.code)).toEqual([
			'similar_trigger_exists',
			'fixed_date_repeats_yearly',
		])

		// Turning a trigger off warns about nothing.
		saved = { ...saved, enabled: false }
		const disabled = await harness.call('update_trigger', { id: NEW, enabled: false })
		expect((JSON.parse(disabled.text) as { warnings: unknown[] }).warnings).toEqual([])
	})
})
