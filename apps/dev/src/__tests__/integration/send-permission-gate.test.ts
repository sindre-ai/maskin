import { events, objects, sendPermissions } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSlackMcpServer } from '../../lib/integrations/providers/slack/mcp-server'
import { DELIVERED_ACTION, recordObjectApproval } from '../../lib/object-delivery'
import { buildObjectPreview } from '../../lib/object-preview'
import { AUTO_SENT_ACTION, authorizeSend } from '../../lib/send-permissions'
import { insertActor, insertObject, insertSendPermission, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

/**
 * The send gate (lib/send-permissions.ts) against real Postgres, through the Slack send tool.
 * Slack is only a stand-in for the tool: every send tool with an object_id goes through the same
 * authorizeSend. Slack itself is a stubbed fetch, which says nothing about what Slack does.
 *
 * Slack messages start on Always allow, so a workspace made here sends without approval until a
 * test says otherwise.
 */

const CHANNEL_ID = 'C0123456789'
const OTHER_CHANNEL_ID = 'C0999999999'

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
	fetchMock = vi.fn().mockResolvedValue({
		ok: true,
		json: async () => ({ ok: true, ts: '1717000000.000100', channel: CHANNEL_ID }),
	} as Response)
	vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

/**
 * Drafts go to `channel`. The Slack tool is given `allowlist` as the channels that may be posted
 * to without a person; by default that is the draft's own channel, so the cases below are about
 * the setting alone. The limit has its own describe at the end.
 */
async function setup(
	content = 'Release 4.2 is out.',
	{
		channel = CHANNEL_ID,
		allowlist = [CHANNEL_ID],
	}: { channel?: string; allowlist?: string[] } = {},
) {
	const actorId = getTestActorId()
	const ws = await insertWorkspace(db, actorId)
	const object = await insertObject(db, ws.id, actorId, {
		type: 'task',
		content,
		metadata: { kind: 'slack_message', channel },
	})
	const server = createSlackMcpServer({
		botToken: 'xoxb-test-token',
		integrationId: 'int-1',
		agentLabel: 'Test agent · in test-workspace',
		workspaceId: ws.id,
		actorId,
		db,
		directPostChannels: allowlist,
	})
	const tool = (
		server as unknown as {
			_registeredTools: Record<
				string,
				{ handler: (args: unknown, extra: unknown) => Promise<unknown> }
			>
		}
	)._registeredTools.slack_send_message
	const send = () =>
		tool.handler({ object_id: object.id }, {}) as Promise<{
			isError?: boolean
			content: Array<{ text: string }>
		}>
	return { actorId, ws, object, send }
}

const eventsOn = (objectId: string, action: string) =>
	db
		.select()
		.from(events)
		.where(and(eq(events.entityId, objectId), eq(events.action, action)))

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

describe('Always allow', () => {
	it('sends with no approval, and writes auto_sent with the kind, the hash and the setting', async () => {
		const { send, object, ws, actorId } = await setup()
		await insertSendPermission(db, {
			workspaceId: ws.id,
			agentId: actorId,
			kind: 'slack_message',
			mode: 'always_allow',
		})

		const result = await send()

		expect(result.isError).toBeUndefined()
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const auto = await eventsOn(object.id, AUTO_SENT_ACTION)
		expect(auto).toHaveLength(1)
		expect(auto[0].actorId).toBe(actorId)
		expect(auto[0].data).toMatchObject({
			kind: 'slack_message',
			content_hash: buildObjectPreview(object)?.content_hash,
			setting: { mode: 'always_allow', source: 'agent' },
		})
		expect(await eventsOn(object.id, DELIVERED_ACTION)).toHaveLength(1)
	})

	it('sends once: the same text is not sent again, and no second auto_sent is written', async () => {
		const { send, object } = await setup()

		expect((await send()).isError).toBeUndefined()
		const again = await send()

		expect(again.isError).toBe(true)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(await eventsOn(object.id, AUTO_SENT_ACTION)).toHaveLength(1)
	})

	it('uses a person’s approval when there is one, and writes no auto_sent', async () => {
		const { send, object, ws, actorId } = await setup()
		await approve(ws.id, actorId, object)

		expect((await send()).isError).toBeUndefined()
		expect(await eventsOn(object.id, AUTO_SENT_ACTION)).toHaveLength(0)
	})

	it('reuses one auto_sent for the same text, so a retry keeps the same key', async () => {
		const { object, ws, actorId } = await setup()
		const preview = buildObjectPreview(object)
		if (!preview) throw new Error('not a draft')
		const gate = () =>
			authorizeSend(db, {
				workspaceId: ws.id,
				agentId: actorId,
				object: { id: object.id, type: object.type },
				preview,
			})

		const [a, b] = await Promise.all([gate(), gate()])
		const c = await gate()

		for (const r of [a, b, c]) expect(r.outcome).toBe('allowed')
		const ids = new Set([a, b, c].map((r) => (r.outcome === 'allowed' ? r.approval.id : null)))
		expect(ids.size).toBe(1)
		expect(await eventsOn(object.id, AUTO_SENT_ACTION)).toHaveLength(1)
	})

	it('needs a new auto_sent when the text changes', async () => {
		const { send, object } = await setup()
		await send()
		await db
			.update(objects)
			.set({ content: 'Release 4.3 is out.' })
			.where(eq(objects.id, object.id))

		expect((await send()).isError).toBeUndefined()
		expect(await eventsOn(object.id, AUTO_SENT_ACTION)).toHaveLength(2)
	})
})

describe('Ask first', () => {
	it('refuses until a person approves the exact text, and writes no auto_sent', async () => {
		const { send, object, ws, actorId } = await setup()
		await insertSendPermission(db, {
			workspaceId: ws.id,
			kind: 'slack_message',
			mode: 'ask_first',
		})

		const refused = await send()
		expect(refused.isError).toBe(true)
		expect(refused.content[0].text).toMatch(/No person has approved/)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await eventsOn(object.id, AUTO_SENT_ACTION)).toHaveLength(0)

		await approve(ws.id, actorId, object)
		expect((await send()).isError).toBeUndefined()
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('holds a text that was edited after the approval', async () => {
		const { send, object, ws, actorId } = await setup()
		await insertSendPermission(db, {
			workspaceId: ws.id,
			kind: 'slack_message',
			mode: 'ask_first',
		})
		await approve(ws.id, actorId, object)
		await db
			.update(objects)
			.set({ content: 'Something else entirely.' })
			.where(eq(objects.id, object.id))

		expect((await send()).isError).toBe(true)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe('Deny', () => {
	it('refuses, says so plainly, and sends nothing, even a text a person approved', async () => {
		const { send, object, ws, actorId } = await setup()
		await insertSendPermission(db, {
			workspaceId: ws.id,
			agentId: actorId,
			kind: 'slack_message',
			mode: 'deny',
		})
		await approve(ws.id, actorId, object)

		const result = await send()

		expect(result.isError).toBe(true)
		expect(result.content[0].text).toMatch(/turned off for you/)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await eventsOn(object.id, AUTO_SENT_ACTION)).toHaveLength(0)
		expect(await eventsOn(object.id, DELIVERED_ACTION)).toHaveLength(0)
	})
})

describe('changing a setting', () => {
	it('applies to the next send', async () => {
		const { send, object, ws, actorId } = await setup()
		await insertSendPermission(db, {
			workspaceId: ws.id,
			agentId: actorId,
			kind: 'slack_message',
			mode: 'deny',
		})
		expect((await send()).isError).toBe(true)

		await db
			.update(sendPermissions)
			.set({ mode: 'always_allow' })
			.where(eq(sendPermissions.workspaceId, ws.id))
		expect((await send()).isError).toBeUndefined()
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(await eventsOn(object.id, AUTO_SENT_ACTION)).toHaveLength(1)
	})
})

describe('which setting wins', () => {
	it('an agent’s own setting beats the workspace default, in both directions', async () => {
		const first = await setup()
		await insertSendPermission(db, {
			workspaceId: first.ws.id,
			kind: 'slack_message',
			mode: 'deny',
		})
		await insertSendPermission(db, {
			workspaceId: first.ws.id,
			agentId: first.actorId,
			kind: 'slack_message',
			mode: 'always_allow',
		})
		expect((await first.send()).isError).toBeUndefined()

		const second = await setup()
		await insertSendPermission(db, {
			workspaceId: second.ws.id,
			kind: 'slack_message',
			mode: 'always_allow',
		})
		await insertSendPermission(db, {
			workspaceId: second.ws.id,
			agentId: second.actorId,
			kind: 'slack_message',
			mode: 'deny',
		})
		expect((await second.send()).isError).toBe(true)
	})

	it('another agent’s setting does not apply to this one', async () => {
		const { send, ws } = await setup()
		const other = await insertActor(db, { type: 'agent' })
		await insertSendPermission(db, {
			workspaceId: ws.id,
			agentId: other.id,
			kind: 'slack_message',
			mode: 'deny',
		})
		expect((await send()).isError).toBeUndefined()
	})

	it('a setting for one kind does not apply to another', async () => {
		const { send, ws, actorId } = await setup()
		await insertSendPermission(db, {
			workspaceId: ws.id,
			agentId: actorId,
			kind: 'email',
			mode: 'deny',
		})
		expect((await send()).isError).toBeUndefined()
	})

	it('a setting in another workspace does not apply', async () => {
		const { send, actorId } = await setup()
		const elsewhere = await insertWorkspace(db, actorId)
		await insertSendPermission(db, {
			workspaceId: elsewhere.id,
			agentId: actorId,
			kind: 'slack_message',
			mode: 'deny',
		})
		expect((await send()).isError).toBeUndefined()
	})
})

describe('email starts on Ask first', () => {
	it('holds an email draft with no setting saved', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const object = await insertObject(db, ws.id, actorId, {
			type: 'task',
			content: 'Hi Mette, Thursday works.',
			metadata: { kind: 'email', to: 'mette@northwind.dk', subject: 'Thursday' },
		})
		const preview = buildObjectPreview(object)
		if (!preview) throw new Error('not a draft')

		const decision = await authorizeSend(db, {
			workspaceId: ws.id,
			agentId: actorId,
			object: { id: object.id, type: object.type },
			preview,
		})
		expect(decision.outcome).toBe('needs_approval')
	})
})

describe('Always allow on Slack only covers the direct-post allowlist', () => {
	it('holds a channel that is not on the allowlist, and writes no auto_sent', async () => {
		const { send, object, ws, actorId } = await setup(undefined, { channel: OTHER_CHANNEL_ID })
		await insertSendPermission(db, {
			workspaceId: ws.id,
			agentId: actorId,
			kind: 'slack_message',
			mode: 'always_allow',
		})

		const held = await send()

		expect(held.isError).toBe(true)
		expect(held.content[0].text).toMatch(/not on the list of channels/)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await eventsOn(object.id, AUTO_SENT_ACTION)).toHaveLength(0)

		await approve(ws.id, actorId, object)
		expect((await send()).isError).toBeUndefined()
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(await eventsOn(object.id, AUTO_SENT_ACTION)).toHaveLength(0)
	})

	it('sends to an allowlisted channel and writes auto_sent', async () => {
		const { send, object, ws, actorId } = await setup(undefined, {
			channel: OTHER_CHANNEL_ID,
			allowlist: [OTHER_CHANNEL_ID],
		})
		await insertSendPermission(db, {
			workspaceId: ws.id,
			agentId: actorId,
			kind: 'slack_message',
			mode: 'always_allow',
		})

		expect((await send()).isError).toBeUndefined()
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(await eventsOn(object.id, AUTO_SENT_ACTION)).toHaveLength(1)
	})

	it('holds when the allowlist is empty', async () => {
		const { send, object } = await setup(undefined, { allowlist: [] })

		expect((await send()).isError).toBe(true)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await eventsOn(object.id, AUTO_SENT_ACTION)).toHaveLength(0)
	})

	it('Deny still wins on an allowlisted channel, even for an approved text', async () => {
		const { send, object, ws, actorId } = await setup()
		await insertSendPermission(db, {
			workspaceId: ws.id,
			agentId: actorId,
			kind: 'slack_message',
			mode: 'deny',
		})
		await approve(ws.id, actorId, object)

		const result = await send()

		expect(result.isError).toBe(true)
		expect(result.content[0].text).toMatch(/turned off for you/)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('Deny wins over a channel that is not on the allowlist too', async () => {
		const { send, ws, actorId } = await setup(undefined, { channel: OTHER_CHANNEL_ID })
		await insertSendPermission(db, {
			workspaceId: ws.id,
			agentId: actorId,
			kind: 'slack_message',
			mode: 'deny',
		})

		const result = await send()

		expect(result.isError).toBe(true)
		expect(result.content[0].text).toMatch(/turned off for you/)
	})
})
