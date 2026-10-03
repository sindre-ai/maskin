import { integrations, objects } from '@maskin/db/schema'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { logger } from '../../lib/logger'
import { FOLLOWUP_REQUEST_TOOL } from '../../lib/outreach/voice/followup-hook'
import { postCallHooks, runPostCallHooks } from '../../lib/outreach/voice/post-call'
import { VOICE_OPT_OUT_ADDRESS } from '../../lib/outreach/voice/send-followup'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// The registered post-call hook against real Postgres. Only global fetch under
// the Resend SDK is stubbed, so the assertions are on what leaves the process.
const fetchMock = vi.fn()

async function setup(metadata: Record<string, unknown>, status?: string) {
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
		...(status ? { status } : {}),
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
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

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

	it('does not send when the prospect did not ask (no request tool in the trace), and logs the skip', async () => {
		const info = vi.spyOn(logger, 'info')
		const s = await setup({
			email: 'pia@prospect.example',
			voice_tool_trace: [{ tool_name: 'end_call_polite' }],
		})
		await runPostCallHooks(hangup(s))
		expect(fetchMock).not.toHaveBeenCalled()
		expect(info).toHaveBeenCalledWith(
			'voice.email.send_skipped',
			expect.objectContaining({ contactId: s.contactId, reason: 'no_followup_request' }),
		)
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

	it('sends nothing on a second call to a contact that already got the email', async () => {
		const s = await setup({
			email: 'pia@prospect.example',
			voice_tool_trace: [{ tool_name: FOLLOWUP_REQUEST_TOOL }],
		})
		await runPostCallHooks(hangup(s, 'call-hook-1'))
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const firstStamp = (await metadataOf(s.contactId)).consent_captured_at
		expect(firstStamp).toBeTruthy()

		await runPostCallHooks(hangup(s, 'call-hook-2'))
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const meta = await metadataOf(s.contactId)
		expect(meta.consent_call_id).toBe('call-hook-1')
		expect(meta.consent_captured_at).toBe(firstStamp)
	})

	it('skips with already_emailed when consent_captured_at is set, even for a different call id', async () => {
		const s = await setup({
			email: 'pia@prospect.example',
			consent_captured_at: '2026-09-30T10:00:00.000Z',
			consent_call_id: 'call-earlier',
			voice_tool_trace: [{ tool_name: FOLLOWUP_REQUEST_TOOL }],
		})
		await runPostCallHooks(hangup(s, 'call-hook-2'))
		expect(fetchMock).not.toHaveBeenCalled()
		expect((await metadataOf(s.contactId)).consent_call_id).toBe('call-earlier')
	})

	it('sends a Danish body with the opt-out line and Maskin as sender', async () => {
		const s = await setup({
			email: 'pia@prospect.example',
			voice_tool_trace: [{ tool_name: FOLLOWUP_REQUEST_TOOL }],
		})
		await runPostCallHooks(hangup(s))
		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
		expect(body.subject).toBe('Opfølgning på vores samtale')
		expect(body.text).toContain('Hej Pia Prospect,')
		expect(body.text).toContain('Tak fordi du tog dig tid')
		expect(body.text).toContain('Hvis du ikke ønsker flere e-mails fra Maskin')
		expect(body.text).toContain(VOICE_OPT_OUT_ADDRESS)
		expect(body.text).not.toContain('noreply@')
		expect(body.reply_to).toBe(VOICE_OPT_OUT_ADDRESS)
		expect(body.text).toContain('— Maskin')
		expect(body.html).toContain('Hvis du ikke ønsker flere e-mails fra Maskin')
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

	it('sends once when the consent write fails after Resend accepted and the same hangup is replayed', async () => {
		const s = await setup({
			email: 'pia@prospect.example',
			voice_tool_trace: [{ tool_name: FOLLOWUP_REQUEST_TOOL }],
		})
		// A real database failure on the consent_* write for this contact only. The
		// claim write before the send carries no consent_captured_at, so it passes.
		await db.execute(
			sql.raw(
				`CREATE OR REPLACE FUNCTION voice_test_fail_consent_write() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'simulated consent write failure'; END; $fn$`,
			),
		)
		await db.execute(
			sql.raw(
				`CREATE TRIGGER voice_test_fail_consent_write BEFORE UPDATE ON objects FOR EACH ROW WHEN (OLD.id = '${s.contactId}' AND jsonb_exists(NEW.metadata, 'consent_captured_at')) EXECUTE FUNCTION voice_test_fail_consent_write()`,
			),
		)
		try {
			const error = vi.spyOn(logger, 'error')
			await runPostCallHooks(hangup(s))
			expect(fetchMock).toHaveBeenCalledTimes(1)
			expect(error).toHaveBeenCalledWith(
				'voice post-call hook failed',
				expect.objectContaining({ hook: 'followup-email', callId: 'call-hook-1' }),
			)
			const afterFailure = await metadataOf(s.contactId)
			expect(afterFailure).not.toHaveProperty('consent_captured_at')

			await runPostCallHooks(hangup(s))
			expect(fetchMock).toHaveBeenCalledTimes(1)
		} finally {
			await db.execute(sql.raw('DROP TRIGGER IF EXISTS voice_test_fail_consent_write ON objects'))
			await db.execute(sql.raw('DROP FUNCTION IF EXISTS voice_test_fail_consent_write()'))
		}
	})

	it('still sends the email on a retried hangup when Resend rejected the first attempt', async () => {
		const s = await setup({
			email: 'pia@prospect.example',
			voice_tool_trace: [{ tool_name: FOLLOWUP_REQUEST_TOOL }],
		})
		fetchMock.mockImplementationOnce(
			async () =>
				new Response(JSON.stringify({ name: 'validation_error', message: 'x', statusCode: 422 }), {
					status: 422,
				}),
		)
		await runPostCallHooks(hangup(s))
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect((await metadataOf(s.contactId)).consent_captured_at).toBeUndefined()

		await runPostCallHooks(hangup(s))
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect((await metadataOf(s.contactId)).consent_call_id).toBe('call-hook-1')
	})

	describe('shared email-hook deny list (checkEmailHookDenyList)', () => {
		const asked = [{ tool_name: FOLLOWUP_REQUEST_TOOL }]

		it('still sends to a contact that ended the call on follow_up_later with a request trace and a quote on record', async () => {
			const s = await setup(
				{
					email: 'pia@prospect.example',
					voice_tool_trace: asked,
					consent_quote: 'ja tak, send mig en mail',
				},
				'follow_up_later',
			)
			await runPostCallHooks({ ...hangup(s), status: 'follow_up_later' })
			expect(fetchMock).toHaveBeenCalledTimes(1)
			expect((await metadataOf(s.contactId)).consent_call_id).toBe('call-hook-1')
		})

		const denied: Array<{
			name: string
			metadata: Record<string, unknown>
			status?: string
			check: string
		}> = [
			{ name: 'approval_hold', metadata: { approval_hold: { by: 'sebk' } }, check: 'hold' },
			{ name: 'held_reason', metadata: { held_reason: 'legal review' }, check: 'hold' },
			{ name: 'protected', metadata: { protected: true }, check: 'protect' },
			{ name: 'deleted_by_request', metadata: {}, status: 'deleted_by_request', check: 'status' },
			{ name: 'rejected', metadata: {}, status: 'rejected', check: 'status' },
		]

		it.each(denied)(
			'skips a $name contact with a logged reason and sends nothing',
			async ({ metadata, status, check }) => {
				const info = vi.spyOn(logger, 'info')
				const s = await setup(
					{ email: 'pia@prospect.example', voice_tool_trace: asked, ...metadata },
					status,
				)
				await runPostCallHooks({ ...hangup(s), status: status ?? 'follow_up_later' })
				expect(fetchMock).not.toHaveBeenCalled()
				expect(info).toHaveBeenCalledWith(
					'voice.email.send_skipped',
					expect.objectContaining({
						contactId: s.contactId,
						reason: 'suppressed_by_deny_list',
						check,
						detail: expect.any(String),
					}),
				)
				expect((await metadataOf(s.contactId)).consent_call_id).toBeUndefined()
			},
		)

		it('checks suppression before the trace gate (a held contact with no request is logged as suppressed)', async () => {
			const info = vi.spyOn(logger, 'info')
			const s = await setup({ email: 'pia@prospect.example', approval_hold: true })
			await runPostCallHooks(hangup(s))
			expect(fetchMock).not.toHaveBeenCalled()
			expect(info).toHaveBeenCalledWith(
				'voice.email.send_skipped',
				expect.objectContaining({ reason: 'suppressed_by_deny_list' }),
			)
		})
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
			expect(sentText()).toContain('Du kan deltage i mødet her:')
			expect(sentText()).not.toContain('vælge et tidspunkt')
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
