import { voiceSessions, voiceToolCalls, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import voiceSessionsRoutes from '../../routes/voice-sessions'
import { createVoiceChannel } from '../../services/voice-session-channel'
import { VoiceToolCallLogCleaner } from '../../services/voice-tool-call-log-cleaner'
import { insertActor, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

vi.mock('../../lib/analytics/posthog', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/analytics/posthog')>()),
	capturePosthogEvent: vi.fn(async () => {}),
}))

async function seedCall(opts: { humanId?: string; workspaceId?: string } = {}) {
	const humanId = opts.humanId ?? getTestActorId()
	const agent = await insertActor(db, {
		type: 'agent',
		name: 'Chief of Staff',
		email: null,
		metadata: { voice_enabled: true },
	})
	const ws = opts.workspaceId ? { id: opts.workspaceId } : await insertWorkspace(db, humanId)
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
		.onConflictDoNothing()
	const [row] = await db
		.insert(voiceSessions)
		.values({
			workspaceId: ws.id,
			agentActorId: agent.id,
			humanActorId: humanId,
			status: 'active',
			vendorSessionId: 'vs_test',
			model: 'gpt-realtime',
			startedAt: new Date(Date.now() - 120_000),
			timeoutAt: new Date(Date.now() + 15 * 60_000),
		})
		.returning()
	if (!row) throw new Error('voice session insert failed')
	return { session: row, agent, ws }
}

function channelFor(
	session: typeof voiceSessions.$inferSelect,
	invokeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
) {
	const sent: Array<Record<string, unknown>> = []
	const channel = createVoiceChannel({
		db,
		session,
		agentName: 'Chief of Staff',
		invokeTool: invokeTool as never,
		isReadOnlyTool: () => true,
		send: (m) => sent.push(m as Record<string, unknown>),
	})
	const toolCall = (name: string, args: unknown, callId: string) =>
		channel.onMessage(
			JSON.stringify({ type: 'tool_call', call_id: callId, name, arguments: JSON.stringify(args) }),
		)
	return { channel, sent, toolCall }
}

const text = (t: string, isError = false) => ({ isError, content: [{ type: 'text', text: t }] })

describe('voice tool call log', () => {
	let app: ReturnType<typeof createIntegrationApp>
	beforeEach(() => {
		app = createIntegrationApp({
			path: '/api/voice-sessions',
			module: voiceSessionsRoutes as never,
		})
	})

	const get = (id: string, workspaceId: string, query = '') =>
		app.request(`/api/voice-sessions/${id}/tool-calls${query}`, {
			headers: { 'X-Workspace-Id': workspaceId },
		})

	it('records a call through the channel and returns it, redacted, through the endpoint', async () => {
		const { session, ws } = await seedCall()
		const big = JSON.stringify({ results: [{ id: 'a', content: 'private text '.repeat(3000) }] })
		const { channel, toolCall } = channelFor(session, async (name) =>
			name === 'get_objects' ? text('invalid id: "6cae4b5d"', true) : text(big),
		)
		const cardId = '6cae4b5d-ce70-4254-9f91-8d3a0e24b775'
		await toolCall('get_objects', { ids: ['6cae4b5d'], api_key: 'sekrit-value' }, 'call_a')
		await toolCall('search_objects', { q: 'loops', body: 'hello lars', cardId }, 'call_b')
		await channel.idle()

		const res = await get(session.id, ws.id)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			tool_calls: Array<Record<string, unknown>>
			next_cursor: null
		}
		expect(body.next_cursor).toBeNull()
		expect(body.tool_calls.map((c) => c.tool_name)).toEqual(['get_objects', 'search_objects'])

		const [failed, truncated] = body.tool_calls
		expect(failed).toMatchObject({
			call_id: 'call_a',
			success: false,
			error_code: 'voice_tool_failed',
			error_message: 'invalid id: "6cae4b5d"',
			args_summary: { ids: ['6cae4b5d'], api_key: '[redacted]' },
			output_truncated: false,
		})
		expect(failed?.output_preview).toContain('invalid id')
		expect(JSON.stringify(failed)).not.toContain('sekrit-value')

		expect(truncated).toMatchObject({
			success: true,
			output_chars: big.length,
			output_truncated: true,
			args_summary: { q: 'loops', body: '[10 chars]', cardId },
		})
		expect((truncated?.output_preview as string).length).toBeLessThanOrEqual(500)
		expect(truncated?.output_preview).not.toContain('private text')
		expect(typeof truncated?.latency_ms).toBe('number')
		expect(Number.isNaN(Date.parse(truncated?.started_at as string))).toBe(false)
	})

	it('still answers the model when the log table cannot be written', async () => {
		const { session } = await seedCall()
		// A session id with no voice_sessions row violates the foreign key, so the insert fails.
		const { channel, sent, toolCall } = channelFor(
			{ ...session, id: '00000000-0000-4000-8000-000000000001' },
			async () => text('ok'),
		)
		await toolCall('list_objects', {}, 'call_x')
		await channel.idle()
		const result = sent.find((m) => m.type === 'tool_result') as { ok: boolean }
		expect(result.ok).toBe(true)
		expect(await db.select().from(voiceToolCalls)).toEqual([])
	})

	it('pages with limit and cursor, and rejects a bad limit or cursor', async () => {
		const { session, ws } = await seedCall()
		const { channel, toolCall } = channelFor(session, async () => text('ok'))
		for (let i = 0; i < 3; i++) await toolCall('list_objects', { n: i }, `call_${i}`)
		await channel.idle()

		const first = (await (await get(session.id, ws.id, '?limit=2')).json()) as {
			tool_calls: Array<{ call_id: string }>
			next_cursor: string
		}
		expect(first.tool_calls.map((c) => c.call_id)).toEqual(['call_0', 'call_1'])
		const second = (await (
			await get(session.id, ws.id, `?limit=2&cursor=${first.next_cursor}`)
		).json()) as { tool_calls: Array<{ call_id: string }>; next_cursor: string | null }
		expect(second.tool_calls.map((c) => c.call_id)).toEqual(['call_2'])
		expect(second.next_cursor).toBeNull()

		expect((await get(session.id, ws.id, '?limit=abc')).status).toBe(400)
		expect((await get(session.id, ws.id, '?limit=0')).status).toBe(400)
		expect((await get(session.id, ws.id, '?limit=100000')).status).toBe(400)
		expect((await get(session.id, ws.id, '?cursor=not-a-cursor')).status).toBe(400)
	})

	it('does not show a call through another workspace', async () => {
		const { session, ws } = await seedCall()
		const { channel, toolCall } = channelFor(session, async () => text('ok'))
		await toolCall('list_objects', {}, 'call_1')
		await channel.idle()
		const other = await insertWorkspace(db, getTestActorId())

		expect((await get(session.id, other.id)).status).toBe(404)
		expect((await get(session.id, ws.id)).status).toBe(200)
	})

	it('shows another person’s call to an admin but not to an ordinary member', async () => {
		const speaker = await insertActor(db, { type: 'human', name: 'Speaker' })
		const ws = await insertWorkspace(db, speaker.id)
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: getTestActorId(), role: 'member' })
			.onConflictDoNothing()
		const { session } = await seedCall({ humanId: speaker.id, workspaceId: ws.id })
		const { channel, toolCall } = channelFor(session, async () => text('ok'))
		await toolCall('list_objects', {}, 'call_1')
		await channel.idle()

		expect((await get(session.id, ws.id)).status).toBe(404)
		await db
			.update(workspaceMembers)
			.set({ role: 'admin' })
			.where(
				and(
					eq(workspaceMembers.workspaceId, ws.id),
					eq(workspaceMembers.actorId, getTestActorId()),
				),
			)
		expect((await get(session.id, ws.id)).status).toBe(200)
	})

	it('sweeps rows older than the retention window and keeps newer ones', async () => {
		const { session, ws } = await seedCall()
		const now = new Date('2026-10-28T12:00:00Z')
		const row = (startedAt: Date, callId: string) => ({
			voiceSessionId: session.id,
			workspaceId: ws.id,
			callId,
			startedAt,
			toolName: 'list_objects',
			success: true,
			outputChars: 2,
			latencyMs: 5,
		})
		await db
			.insert(voiceToolCalls)
			.values([
				row(new Date('2026-09-20T12:00:00Z'), 'old'),
				row(new Date('2026-10-20T12:00:00Z'), 'recent'),
			])

		const deleted = await new VoiceToolCallLogCleaner(db).tick(now)
		expect(deleted).toBe(1)
		const left = await db
			.select({ callId: voiceToolCalls.callId })
			.from(voiceToolCalls)
			.where(eq(voiceToolCalls.voiceSessionId, session.id))
		expect(left).toEqual([{ callId: 'recent' }])
	})

	it('removes a call’s rows with the call', async () => {
		const { session, ws } = await seedCall()
		await db.insert(voiceToolCalls).values({
			voiceSessionId: session.id,
			workspaceId: ws.id,
			startedAt: new Date(),
			toolName: 'list_objects',
			success: true,
			outputChars: 2,
			latencyMs: 5,
		})
		await db.delete(voiceSessions).where(eq(voiceSessions.id, session.id))
		expect(
			await db.select().from(voiceToolCalls).where(eq(voiceToolCalls.voiceSessionId, session.id)),
		).toEqual([])
	})
})
