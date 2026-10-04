import { objects } from '@maskin/db/schema'
import type { PgEvent } from '@maskin/realtime'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordEventReturning } from '../../lib/events/record-event'
import { logger } from '../../lib/logger'
import { applyOptOutReply } from '../../lib/outreach/voice/optout-reply'
import { VOICE_OPT_OUT_ADDRESS } from '../../lib/outreach/voice/send-followup'
import { VoiceOptOutListener } from '../../services/voice-optout-listener'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Real Postgres: the status write, the row lock and the sender match are SQL, so
// a mocked query builder would prove nothing about them.
async function workspace() {
	return (await insertWorkspace(db, getTestActorId())).id
}

function contact(
	workspaceId: string,
	email: string,
	status = 'follow_up_later',
	metadata: Record<string, unknown> = {},
) {
	return insertObject(db, workspaceId, getTestActorId(), {
		type: 'contact',
		title: 'Pia Prospect',
		status,
		metadata: { email, consent_call_id: 'call-1', ...metadata },
	})
}

async function row(id: string) {
	const [r] = await db.select().from(objects).where(eq(objects.id, id))
	return r
}

const reply = (workspaceId: string, over: Record<string, unknown> = {}) => ({
	workspaceId,
	emailId: 'email-1',
	from: 'pia@prospect.example',
	to: [VOICE_OPT_OUT_ADDRESS],
	subject: 'Re: Tak for samtalen',
	text: 'STOP',
	...over,
})

describe('applyOptOutReply', () => {
	afterEach(() => vi.restoreAllMocks())

	it('sets the matching contact to rejected on an English stop reply', async () => {
		const ws = await workspace()
		const c = await contact(ws, 'pia@prospect.example')
		const result = await applyOptOutReply(db, reply(ws, { text: 'Please unsubscribe me' }))
		expect(result).toEqual({ changed: true, contactId: c.id, previousStatus: 'follow_up_later' })
		expect((await row(c.id)).status).toBe('rejected')
	})

	it('sets the matching contact to rejected on a Danish stop reply', async () => {
		const ws = await workspace()
		const c = await contact(ws, 'pia@prospect.example')
		await applyOptOutReply(
			db,
			reply(ws, { subject: 'Re: Din samtale', text: 'Afmeld mig venligst' }),
		)
		expect((await row(c.id)).status).toBe('rejected')
	})

	it('matches the sender address case-insensitively and through a display name', async () => {
		const ws = await workspace()
		const c = await contact(ws, 'Pia@Prospect.Example')
		await applyOptOutReply(db, reply(ws, { from: 'PIA PROSPECT <pia@PROSPECT.example>' }))
		expect((await row(c.id)).status).toBe('rejected')
	})

	it('leaves consent_* and voice_* metadata untouched', async () => {
		const ws = await workspace()
		const meta = {
			consent_basis: 'gdpr_6_1_f_legitimate_interest_b2b_voice',
			consent_captured_at: '2026-10-03T10:00:00.000Z',
			voice_tool_trace: [{ tool_name: 'request_followup_email' }],
			voice_first_touch_at: '2026-10-03T09:00:00.000Z',
		}
		const c = await contact(ws, 'pia@prospect.example', 'voice_declined', meta)
		await applyOptOutReply(db, reply(ws))
		const after = await row(c.id)
		expect(after.status).toBe('rejected')
		expect(after.metadata).toEqual({
			email: 'pia@prospect.example',
			consent_call_id: 'call-1',
			...meta,
		})
	})

	it('writes an audit event for the status change', async () => {
		const ws = await workspace()
		const c = await contact(ws, 'pia@prospect.example')
		await applyOptOutReply(db, reply(ws))
		const evs = await db.query.events.findMany({
			where: (e, { and, eq: eqq }) => and(eqq(e.workspaceId, ws), eqq(e.entityId, c.id)),
		})
		expect(evs).toHaveLength(1)
		expect(evs[0].data).toMatchObject({
			source: 'voice_optout_reply',
			email_id: 'email-1',
			fromStatus: 'follow_up_later',
			toStatus: 'rejected',
		})
	})

	it('changes nothing and logs no_matching_contact for an unknown sender', async () => {
		const info = vi.spyOn(logger, 'info')
		const ws = await workspace()
		const c = await contact(ws, 'pia@prospect.example')
		const result = await applyOptOutReply(db, reply(ws, { from: 'stranger@other.example' }))
		expect(result).toEqual({ changed: false, reason: 'no_matching_contact' })
		expect((await row(c.id)).status).toBe('follow_up_later')
		expect(info).toHaveBeenCalledWith(
			'voice.optout.no_change',
			expect.objectContaining({ workspaceId: ws, reason: 'no_matching_contact' }),
		)
	})

	it('changes nothing and logs ambiguous_match when two voice contacts share the address', async () => {
		const info = vi.spyOn(logger, 'info')
		const ws = await workspace()
		const a = await contact(ws, 'shared@prospect.example')
		const b = await contact(ws, 'SHARED@prospect.example', 'voice_no_answer')
		const result = await applyOptOutReply(db, reply(ws, { from: 'shared@prospect.example' }))
		expect(result).toEqual({ changed: false, reason: 'ambiguous_match' })
		expect((await row(a.id)).status).toBe('follow_up_later')
		expect((await row(b.id)).status).toBe('voice_no_answer')
		expect(info).toHaveBeenCalledWith(
			'voice.optout.no_change',
			expect.objectContaining({ reason: 'ambiguous_match', matchCount: 2 }),
		)
	})

	it('changes nothing and logs no_stop_word when the reply has none', async () => {
		const info = vi.spyOn(logger, 'info')
		const ws = await workspace()
		const c = await contact(ws, 'pia@prospect.example')
		const result = await applyOptOutReply(
			db,
			reply(ws, { text: 'Tak, vi vender tilbage.\n\n> we will stop' }),
		)
		expect(result).toEqual({ changed: false, reason: 'no_stop_word' })
		expect((await row(c.id)).status).toBe('follow_up_later')
		expect(info).toHaveBeenCalledWith(
			'voice.optout.no_change',
			expect.objectContaining({ reason: 'no_stop_word' }),
		)
	})

	describe('HTML-only replies', () => {
		const htmlOnly = (workspaceId: string, html: string, over: Record<string, unknown> = {}) =>
			reply(workspaceId, { text: undefined, html, ...over })

		it('sets the matching contact to rejected on an HTML-only Danish stop reply, metadata intact', async () => {
			const ws = await workspace()
			const meta = {
				consent_basis: 'gdpr_6_1_f_legitimate_interest_b2b_voice',
				voice_first_touch_at: '2026-10-03T09:00:00.000Z',
			}
			const c = await contact(ws, 'pia@prospect.example', 'voice_declined', meta)
			const other = await contact(ws, 'ole@prospect.example')
			const result = await applyOptOutReply(
				db,
				htmlOnly(
					ws,
					'<html><head><style>p { color: red }</style></head><body><div dir="ltr">Afmeld&nbsp;mig venligst</div></body></html>',
					{ text: '' },
				),
			)
			expect(result).toEqual({
				changed: true,
				contactId: c.id,
				previousStatus: 'voice_declined',
			})
			const after = await row(c.id)
			expect(after.status).toBe('rejected')
			expect(after.metadata).toEqual({
				email: 'pia@prospect.example',
				consent_call_id: 'call-1',
				...meta,
			})
			expect((await row(other.id)).status).toBe('follow_up_later')
		})

		it('changes nothing when the HTML only quotes our own opt-out line', async () => {
			const info = vi.spyOn(logger, 'info')
			const ws = await workspace()
			const c = await contact(ws, 'pia@prospect.example')
			const quoted =
				'<div>Tak, vi vender tilbage.</div><br>' +
				'<div class="gmail_quote"><div>On Fri, 3 Oct 2026 at 10:00, Rune &lt;rune@maskin.io&gt; wrote:</div>' +
				'<blockquote class="gmail_quote"><p>Svar STOP, so we will stop.</p></blockquote></div>'
			const result = await applyOptOutReply(db, htmlOnly(ws, quoted))
			expect(result).toEqual({ changed: false, reason: 'no_stop_word' })
			expect((await row(c.id)).status).toBe('follow_up_later')
			expect(info).toHaveBeenCalledWith(
				'voice.optout.no_change',
				expect.objectContaining({ reason: 'no_stop_word' }),
			)
		})

		it('still catches a stop word that sits above a quoted original', async () => {
			const ws = await workspace()
			const c = await contact(ws, 'pia@prospect.example')
			const result = await applyOptOutReply(
				db,
				htmlOnly(ws, '<p>STOP</p><blockquote><p>we will stop</p></blockquote>'),
			)
			expect(result).toMatchObject({ changed: true, contactId: c.id })
			expect((await row(c.id)).status).toBe('rejected')
		})

		it('leaves a stranger sender alone on an HTML-only stop word', async () => {
			const info = vi.spyOn(logger, 'info')
			const ws = await workspace()
			const c = await contact(ws, 'pia@prospect.example')
			const result = await applyOptOutReply(
				db,
				htmlOnly(ws, '<p>STOP</p>', { from: 'stranger@elsewhere.example' }),
			)
			expect(result).toEqual({ changed: false, reason: 'no_matching_contact' })
			expect((await row(c.id)).status).toBe('follow_up_later')
			expect(info).toHaveBeenCalledWith(
				'voice.optout.no_change',
				expect.objectContaining({ reason: 'no_matching_contact' }),
			)
		})

		it('prefers the text part when a mail has both parts', async () => {
			const ws = await workspace()
			const c = await contact(ws, 'pia@prospect.example')
			const result = await applyOptOutReply(
				db,
				reply(ws, { text: 'Tak, vi vender tilbage.', html: '<p>STOP</p>' }),
			)
			expect(result).toEqual({ changed: false, reason: 'no_stop_word' })
			expect((await row(c.id)).status).toBe('follow_up_later')
		})

		it('flips the contact from a stored event that carries only html', async () => {
			const ws = await workspace()
			const c = await contact(ws, 'pia@prospect.example')
			const ev = await recordEventReturning(db, {
				workspaceId: ws,
				actorId: getTestActorId(),
				action: 'received',
				entityType: 'resend.email',
				entityId: ws,
				data: {
					email_id: 'em_html',
					from: 'Pia <pia@prospect.example>',
					to: [VOICE_OPT_OUT_ADDRESS],
					subject: 'Re: Tak for samtalen',
					html: '<div>fjern mig</div>',
				},
			})
			const listener = new VoiceOptOutListener(db, {} as never)
			await listener.handleEvent({
				workspace_id: ws,
				actor_id: getTestActorId(),
				action: 'received',
				entity_type: 'resend.email',
				entity_id: ws,
				event_id: String(ev.id),
			} satisfies PgEvent)
			expect((await row(c.id)).status).toBe('rejected')
		})
	})

	it('ignores mail that is not addressed to the opt-out address', async () => {
		const ws = await workspace()
		const c = await contact(ws, 'pia@prospect.example')
		const result = await applyOptOutReply(db, reply(ws, { to: ['sales@maskin.io'] }))
		expect(result).toEqual({ changed: false, reason: 'not_for_opt_out_address' })
		expect((await row(c.id)).status).toBe('follow_up_later')
	})

	it('never matches a contact in another workspace', async () => {
		const ws = await workspace()
		const other = await workspace()
		const c = await contact(other, 'pia@prospect.example')
		const result = await applyOptOutReply(db, reply(ws))
		expect(result).toEqual({ changed: false, reason: 'no_matching_contact' })
		expect((await row(c.id)).status).toBe('follow_up_later')
	})

	it('never matches a contact the voice lane has not touched', async () => {
		const ws = await workspace()
		const c = await insertObject(db, ws, getTestActorId(), {
			type: 'contact',
			title: 'LinkedIn lead',
			status: 'new',
			metadata: { email: 'pia@prospect.example' },
		})
		const result = await applyOptOutReply(db, reply(ws))
		expect(result).toEqual({ changed: false, reason: 'no_matching_contact' })
		expect((await row(c.id)).status).toBe('new')
	})

	it('does not revive an erased contact and is a no-op on an already rejected one', async () => {
		const ws = await workspace()
		const erased = await contact(ws, 'erased@prospect.example', 'deleted_by_request')
		const done = await contact(ws, 'done@prospect.example', 'rejected')
		expect(await applyOptOutReply(db, reply(ws, { from: 'erased@prospect.example' }))).toEqual({
			changed: false,
			reason: 'already_suppressed',
		})
		expect(await applyOptOutReply(db, reply(ws, { from: 'done@prospect.example' }))).toEqual({
			changed: false,
			reason: 'already_suppressed',
		})
		expect((await row(erased.id)).status).toBe('deleted_by_request')
		expect((await row(done.id)).status).toBe('rejected')
	})
})

describe('VoiceOptOutListener', () => {
	it('flips the contact from a stored resend.email received event', async () => {
		const ws = await workspace()
		const c = await contact(ws, 'pia@prospect.example')
		const ev = await recordEventReturning(db, {
			workspaceId: ws,
			actorId: getTestActorId(),
			action: 'received',
			entityType: 'resend.email',
			entityId: ws,
			data: {
				email_id: 'em_1',
				from: 'Pia <pia@prospect.example>',
				to: [VOICE_OPT_OUT_ADDRESS],
				subject: 'Re: Tak for samtalen',
				text: 'afmeld',
			},
		})
		const listener = new VoiceOptOutListener(db, {} as never)
		await listener.handleEvent({
			workspace_id: ws,
			actor_id: getTestActorId(),
			action: 'received',
			entity_type: 'resend.email',
			entity_id: ws,
			event_id: String(ev.id),
		} satisfies PgEvent)
		expect((await row(c.id)).status).toBe('rejected')
	})
})
