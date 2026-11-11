import { events, objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSlackMcpServer } from '../../lib/integrations/providers/slack/mcp-server'
import { DELIVERED_ACTION, recordObjectApproval } from '../../lib/object-delivery'
import { buildObjectPreview } from '../../lib/object-preview'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

/**
 * slack_send_message posts directly to any channel for an agent with write access, or sends a
 * Slack message draft. A person's approval of the draft is optional. The delivery record and the
 * once-only rule live in events (bound to a content hash), so they can only be proven against real Postgres. Slack itself is a stubbed
 * fetch here, which says nothing about what Slack does with the call.
 */

const INTERNAL_CHANNEL_ID = 'C06LC37JJCS'
const OTHER_CHANNEL_ID = 'C0123456789'

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
	fetchMock = vi.fn().mockResolvedValue({
		ok: true,
		json: async () => ({ ok: true, ts: '1717000000.000100', channel: OTHER_CHANNEL_ID }),
	} as Response)
	vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

async function setup(overrides: Record<string, unknown> = {}) {
	const actorId = getTestActorId()
	const ws = await insertWorkspace(db, actorId)
	const object = await insertObject(db, ws.id, actorId, {
		type: 'task',
		content: 'Release 4.2 is out.',
		metadata: { kind: 'slack_message', channel: OTHER_CHANNEL_ID },
		...overrides,
	})
	const server = createSlackMcpServer({
		botToken: 'xoxb-test-token',
		integrationId: 'int-1',
		agentLabel: 'Test agent · in test-workspace',
		workspaceId: ws.id,
		actorId,
		db,
	})
	const tool = (
		server as unknown as {
			_registeredTools: Record<
				string,
				{ handler: (args: unknown, extra: unknown) => Promise<unknown> }
			>
		}
	)._registeredTools.slack_send_message
	const send = (args: Record<string, unknown>) =>
		tool.handler(args, {}) as Promise<{
			isError?: boolean
			content: Array<{ text: string }>
		}>
	return { actorId, ws, object, send }
}

async function approve(wsId: string, actorId: string, object: typeof objects.$inferSelect) {
	const preview = buildObjectPreview(object)
	if (!preview) throw new Error('not a draft')
	await recordObjectApproval(db, {
		workspaceId: wsId,
		actorId,
		objectId: object.id,
		objectType: object.type,
		preview,
		via: 'approval',
	})
}

describe('slack_send_message', () => {
	it('posts directly to any channel with a channel and text, no approval and no list', async () => {
		const { send } = await setup()
		const result = await send({ channel: OTHER_CHANNEL_ID, text: 'hello' })
		expect(result.isError).toBeUndefined()
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)
		expect(body.channel).toBe(OTHER_CHANNEL_ID)
		expect(body.text).toBe('hello')
	})

	it('sends a draft nobody approved, because the agent has write access', async () => {
		const { send, object, ws } = await setup()
		const result = await send({ object_id: object.id })
		expect(result.isError).toBeUndefined()
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const delivered = await db
			.select()
			.from(events)
			.where(
				and(
					eq(events.entityId, object.id),
					eq(events.action, DELIVERED_ACTION),
					eq(events.workspaceId, ws.id),
				),
			)
		expect(delivered).toHaveLength(1)
	})

	it('refuses an object that is not a Slack message draft', async () => {
		const { send, object } = await setup({ metadata: { kind: 'email', to: 'a@example.com' } })
		const result = await send({ object_id: object.id })
		expect(result.isError).toBe(true)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('posts the approved text to the filed channel, once, and records the delivery', async () => {
		const { send, object, ws, actorId } = await setup()
		await approve(ws.id, actorId, object)

		const result = await send({ object_id: object.id })

		expect(result.isError).toBeUndefined()
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)
		expect(body.channel).toBe(OTHER_CHANNEL_ID)
		expect(body.text).toBe('Release 4.2 is out.')
		const delivered = await db
			.select()
			.from(events)
			.where(
				and(
					eq(events.entityId, object.id),
					eq(events.action, DELIVERED_ACTION),
					eq(events.workspaceId, ws.id),
				),
			)
		expect(delivered).toHaveLength(1)
		expect(delivered[0].data).toMatchObject({
			provider: 'slack',
			content_hash: buildObjectPreview(object)?.content_hash,
		})

		const again = await send({ object_id: object.id })
		expect(again.isError).toBe(true)
		expect(again.content[0].text).toMatch(/already been posted/)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('ignores text and channel passed alongside an approved draft', async () => {
		const { send, object, ws, actorId } = await setup()
		await approve(ws.id, actorId, object)
		await send({ object_id: object.id, channel: 'C0999999999', text: 'something else' })
		const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)
		expect(body.channel).toBe(OTHER_CHANNEL_ID)
		expect(body.text).toBe('Release 4.2 is out.')
	})

	it('posts the text and channel the draft holds now, after an edit', async () => {
		const { send, object, ws, actorId } = await setup()
		await approve(ws.id, actorId, object)
		await db
			.update(objects)
			.set({
				content: 'Release 4.2 is out, and so is 4.3.',
				metadata: { kind: 'slack_message', channel: 'C0888888888' },
			})
			.where(eq(objects.id, object.id))

		const result = await send({ object_id: object.id })

		expect(result.isError).toBeUndefined()
		const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)
		expect(body.channel).toBe('C0888888888')
		expect(body.text).toBe('Release 4.2 is out, and so is 4.3.')
	})
})

describe('slack_update_message', () => {
	const TS = '1717000000.000100'

	async function setupUpdate(overrides: Record<string, unknown> = {}) {
		const base = await setup({ content: 'Release 4.2 is out (fixed link).', ...overrides })
		const server = createSlackMcpServer({
			botToken: 'xoxb-test-token',
			integrationId: 'int-1',
			agentLabel: 'Test agent · in test-workspace',
			workspaceId: base.ws.id,
			actorId: base.actorId,
			db,
		})
		const tool = (
			server as unknown as {
				_registeredTools: Record<
					string,
					{ handler: (args: unknown, extra: unknown) => Promise<unknown> }
				>
			}
		)._registeredTools.slack_update_message
		const update = (args: Record<string, unknown>) =>
			tool.handler(args, {}) as Promise<{
				isError?: boolean
				content: Array<{ text: string }>
			}>
		return { ...base, update }
	}

	function sentToSlack() {
		return fetchMock.mock.calls.map((c) => ({
			url: c[0] as string,
			body: JSON.parse((c[1] as RequestInit).body as string),
		}))
	}

	it('edits directly in any channel with a channel, ts and text', async () => {
		const { update } = await setupUpdate()
		const result = await update({ channel: OTHER_CHANNEL_ID, ts: TS, text: 'rewritten' })
		expect(result.isError).toBeUndefined()
		const [call] = sentToSlack()
		expect(call.url).toBe('https://slack.com/api/chat.update')
		expect(call.body).toMatchObject({ channel: OTHER_CHANNEL_ID, ts: TS, text: 'rewritten' })
	})

	it('applies a draft nobody approved', async () => {
		const { update, object } = await setupUpdate()
		const result = await update({ object_id: object.id, ts: TS })
		expect(result.isError).toBeUndefined()
		expect(sentToSlack()).toHaveLength(1)
	})

	it('applies the approved text to the filed channel, once, and records it', async () => {
		const { update, object, ws, actorId } = await setupUpdate()
		await approve(ws.id, actorId, object)

		const result = await update({ object_id: object.id, ts: TS })

		expect(result.isError).toBeUndefined()
		const calls = sentToSlack()
		expect(calls).toHaveLength(1)
		expect(calls[0].url).toBe('https://slack.com/api/chat.update')
		expect(calls[0].body).toEqual({
			channel: OTHER_CHANNEL_ID,
			ts: TS,
			text: 'Release 4.2 is out (fixed link).',
		})
		const delivered = await db
			.select()
			.from(events)
			.where(
				and(
					eq(events.entityId, object.id),
					eq(events.action, DELIVERED_ACTION),
					eq(events.workspaceId, ws.id),
				),
			)
		expect(delivered).toHaveLength(1)
		expect(delivered[0].data).toMatchObject({ provider: 'slack', ts: TS })

		const again = await update({ object_id: object.id, ts: TS })
		expect(again.isError).toBe(true)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('ignores channel and text passed alongside an approved draft', async () => {
		const { update, object, ws, actorId } = await setupUpdate()
		await approve(ws.id, actorId, object)
		await update({ object_id: object.id, ts: TS, channel: 'C0999999999', text: 'something else' })
		expect(sentToSlack()[0].body).toMatchObject({
			channel: OTHER_CHANNEL_ID,
			text: 'Release 4.2 is out (fixed link).',
		})
	})
})
