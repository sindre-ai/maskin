import { integrations, objects } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { FOLLOWUP_REQUEST_TOOL } from '../../lib/outreach/voice/followup-hook'
import { postCallHooks, runPostCallHooks } from '../../lib/outreach/voice/post-call'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// The registered post-call hook against real Postgres. Only global fetch under
// the Resend SDK is stubbed, so the assertions are on what leaves the process.
const fetchMock = vi.fn()

async function setup(metadata: Record<string, unknown>) {
	const ws = await insertWorkspace(db, getTestActorId())
	await db.insert(integrations).values({
		workspaceId: ws.id,
		provider: 'resend',
		status: 'active',
		credentials: encrypt(JSON.stringify({ accessToken: 're_key_hook' })),
		config: { resend: { send_from: 'noreply@agent.hook.example' } },
		createdBy: getTestActorId(),
	})
	const contact = await insertObject(db, ws.id, getTestActorId(), {
		type: 'contact',
		title: 'Pia Prospect',
		metadata,
	})
	return { workspaceId: ws.id, contactId: contact.id }
}

const hangup = (s: { workspaceId: string; contactId: string }, callId = 'call-hook-1') => ({
	db,
	workspaceId: s.workspaceId,
	contactId: s.contactId,
	callId,
	status: 'voice_declined',
	hangupCause: 'normal_clearing',
	durationS: 40,
	recordingUrl: null,
	transcriptUrl: null,
})

async function metadataOf(id: string) {
	const [row] = await db.select().from(objects).where(eq(objects.id, id))
	return row.metadata as Record<string, unknown>
}

describe('post-call follow-up email hook', () => {
	beforeEach(() => {
		fetchMock.mockReset()
		fetchMock.mockImplementation(
			async () => new Response(JSON.stringify({ id: 'email_1' }), { status: 200 }),
		)
		vi.stubGlobal('fetch', fetchMock)
	})
	afterEach(() => vi.unstubAllGlobals())

	it('is registered in the default hook list', () => {
		expect(postCallHooks.map((h) => h.name)).toContain('followup-email')
	})

	it('sends from the workspace identity when the prospect asked for the email on the call', async () => {
		const s = await setup({
			email: 'pia@prospect.example',
			last_call_id: 'call-hook-1',
			voice_tool_trace: [{ tool_name: FOLLOWUP_REQUEST_TOOL }],
		})
		await runPostCallHooks(hangup(s))
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const [, init] = fetchMock.mock.calls[0]
		expect(new Headers(init.headers).get('authorization')).toBe('Bearer re_key_hook')
		const body = JSON.parse(init.body as string)
		expect(body.to).toBe('pia@prospect.example')
		expect(body.from).toContain('noreply@agent.hook.example')
		const meta = await metadataOf(s.contactId)
		expect(meta.consent_call_id).toBe('call-hook-1')
		expect(meta.last_call_id).toBe('call-hook-1')
	})

	it('does not send when the prospect did not ask (no request tool in the trace)', async () => {
		const s = await setup({
			email: 'pia@prospect.example',
			voice_tool_trace: [{ tool_name: 'end_call_polite' }],
		})
		await runPostCallHooks(hangup(s))
		expect(fetchMock).not.toHaveBeenCalled()
		expect((await metadataOf(s.contactId)).consent_call_id).toBeUndefined()
	})

	it('does not send twice for the same call id', async () => {
		const s = await setup({
			email: 'pia@prospect.example',
			voice_tool_trace: [{ tool_name: FOLLOWUP_REQUEST_TOOL }],
		})
		await runPostCallHooks(hangup(s))
		await runPostCallHooks(hangup(s))
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('skips without sending when the contact has no email on file', async () => {
		const s = await setup({ voice_tool_trace: [{ tool_name: FOLLOWUP_REQUEST_TOOL }] })
		await runPostCallHooks(hangup(s))
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('does not send for a disclosure_missing contact', async () => {
		const s = await setup({
			email: 'pia@prospect.example',
			compliance_flag: 'disclosure_missing',
			voice_tool_trace: [{ tool_name: FOLLOWUP_REQUEST_TOOL }],
		})
		await runPostCallHooks(hangup(s))
		expect(fetchMock).not.toHaveBeenCalled()
		expect((await metadataOf(s.contactId)).consent_call_id).toBeUndefined()
	})

	describe('Meet link', () => {
		const asked = [{ tool_name: FOLLOWUP_REQUEST_TOOL }]
		const link = 'https://meet.google.com/abc-defg-hij'
		const sentText = () => JSON.parse(fetchMock.mock.calls[0][1].body as string).text as string

		it('includes the link when voice_meeting is from this call and meet_link is set', async () => {
			const s = await setup({
				email: 'pia@prospect.example',
				voice_tool_trace: asked,
				voice_meeting: { call_id: 'call-hook-1', meet_link: link },
			})
			await runPostCallHooks(hangup(s))
			expect(sentText()).toContain(link)
		})

		it('passes no link when voice_meeting names an earlier call', async () => {
			const s = await setup({
				email: 'pia@prospect.example',
				voice_tool_trace: asked,
				voice_meeting: { call_id: 'call-earlier', meet_link: link },
			})
			await runPostCallHooks(hangup(s))
			expect(fetchMock).toHaveBeenCalledTimes(1)
			expect(sentText()).not.toContain(link)
		})

		it('passes no link when meet_link is null, or when there is no voice_meeting', async () => {
			const nullLink = await setup({
				email: 'pia@prospect.example',
				voice_tool_trace: asked,
				voice_meeting: { call_id: 'call-hook-1', meet_link: null },
			})
			await runPostCallHooks(hangup(nullLink))
			const none = await setup({ email: 'pia@prospect.example', voice_tool_trace: asked })
			await runPostCallHooks(hangup(none))
			expect(fetchMock).toHaveBeenCalledTimes(2)
			for (const [, init] of fetchMock.mock.calls) {
				expect(JSON.parse(init.body as string).text).not.toContain('https://')
			}
		})
	})
})
