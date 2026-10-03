import { events, objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { disclosureHook, interestPingHook } from '../../lib/outreach/voice/call-hooks'
import {
	type PostCallContext,
	postCallHooks,
	runPostCallHooks,
} from '../../lib/outreach/voice/post-call'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

async function newContact(metadata: Record<string, unknown> = {}) {
	const ws = await insertWorkspace(db, getTestActorId())
	const contact = await insertObject(db, ws.id, getTestActorId(), {
		type: 'contact',
		status: 'voice_declined',
		title: 'Pia Prospect',
		metadata: { last_call_id: 'call-1', ...metadata },
	})
	const ctx = (over: Partial<PostCallContext> = {}): PostCallContext => ({
		db,
		workspaceId: ws.id,
		contactId: contact.id,
		callId: 'call-1',
		status: 'voice_declined',
		hangupCause: 'normal_clearing',
		durationS: 60,
		recordingUrl: 'https://rec.example/1',
		transcriptUrl: 'https://tr.example/1',
		prospectPhone: '+4511111111',
		transcript: undefined,
		...over,
	})
	const meta = async () => {
		const [row] = await db.select().from(objects).where(eq(objects.id, contact.id))
		return (row?.metadata ?? {}) as Record<string, unknown>
	}
	const eventsOf = (action: string) =>
		db
			.select()
			.from(events)
			.where(and(eq(events.entityId, contact.id), eq(events.action, action)))
	return { ws, contact, ctx, meta, eventsOf }
}

const GOOD = [
	{
		role: 'assistant',
		text: 'Hi Pia, this is an AI assistant calling on behalf of Maskin, do you have a moment?',
	},
	{ role: 'user', text: 'Sure' },
]

describe('disclosureHook', () => {
	it('is registered first, ahead of any later hook', () => {
		expect(postCallHooks[0]).toBe(disclosureHook)
	})

	it('passes quietly when the first agent utterance carries the AI-assistant phrase', async () => {
		const c = await newContact()
		await runPostCallHooks(c.ctx({ transcript: GOOD }), [disclosureHook])
		expect((await c.meta()).compliance_flag).toBeUndefined()
		expect(await c.eventsOf('voice_disclosure_missing_ping')).toHaveLength(0)
	})

	it('accepts the Danish AI-assistent wording', async () => {
		const c = await newContact()
		await runPostCallHooks(
			c.ctx({
				transcript: [
					{
						role: 'assistant',
						text: 'Hej Pia, det her er en AI-assistent, der ringer på vegne af Maskin',
					},
				],
			}),
			[disclosureHook],
		)
		expect((await c.meta()).compliance_flag).toBeUndefined()
	})

	it('stamps compliance_flag and pings #sales at Attention 5 when the first utterance omits it', async () => {
		const c = await newContact()
		await runPostCallHooks(
			c.ctx({
				transcript: [
					{ role: 'assistant', text: 'Hi Pia, this is Sebastian from Maskin' },
					{ role: 'assistant', text: 'By the way I am an AI assistant' },
				],
			}),
			[disclosureHook],
		)
		expect((await c.meta()).compliance_flag).toBe('disclosure_missing')
		const [ping] = await c.eventsOf('voice_disclosure_missing_ping')
		expect(ping?.data).toMatchObject({ attention: 5, channel: '#sales', call_id: 'call-1' })
	})

	it('fails closed: a connected call whose transcript has no agent utterance is flagged', async () => {
		const c = await newContact()
		await runPostCallHooks(c.ctx({ transcript: undefined }), [disclosureHook])
		expect((await c.meta()).compliance_flag).toBe('disclosure_missing')
	})

	it('does not check a call that never connected', async () => {
		const c = await newContact()
		await runPostCallHooks(c.ctx({ hangupCause: 'no_answer', durationS: null }), [disclosureHook])
		await runPostCallHooks(c.ctx({ hangupCause: 'normal_clearing', durationS: 0 }), [
			disclosureHook,
		])
		expect((await c.meta()).compliance_flag).toBeUndefined()
	})

	it('keeps the rest of the contact metadata when it stamps the flag', async () => {
		const c = await newContact({ owner: 'sebk' })
		await runPostCallHooks(c.ctx({ transcript: [{ role: 'assistant', text: 'Hello there' }] }), [
			disclosureHook,
		])
		const m = await c.meta()
		expect(m.owner).toBe('sebk')
		expect(m.last_call_id).toBe('call-1')
	})
})

describe('interestPingHook', () => {
	const interest = (over: Record<string, unknown> = {}) => ({
		voice_interest: {
			call_id: 'call-1',
			strength: 'warm',
			reason: 'open to a meeting',
			ping: 'pending',
			...over,
		},
	})

	it('pings #sales at Attention 4 with the phone, transcript link and recording link, once', async () => {
		const c = await newContact(interest())
		await runPostCallHooks(c.ctx(), [interestPingHook])
		const rows = await c.eventsOf('voice_warm_lead_ping')
		expect(rows).toHaveLength(1)
		expect(rows[0]?.data).toMatchObject({
			attention: 4,
			channel: '#sales',
			phone: '+4511111111',
			transcript_url: 'https://tr.example/1',
			recording_url: 'https://rec.example/1',
		})
		expect((rows[0]?.data as { text: string }).text).toContain('Pia Prospect')
		expect(((await c.meta()).voice_interest as { ping: string }).ping).toBe('sent')

		await runPostCallHooks(c.ctx(), [interestPingHook])
		expect(await c.eventsOf('voice_warm_lead_ping')).toHaveLength(1)
	})

	it('stays quiet when a live transfer started (ping not_needed)', async () => {
		const c = await newContact(interest({ strength: 'hot', ping: 'not_needed' }))
		await runPostCallHooks(c.ctx(), [interestPingHook])
		expect(await c.eventsOf('voice_warm_lead_ping')).toHaveLength(0)
	})

	it('stays quiet when the flag belongs to an earlier call', async () => {
		const c = await newContact(interest({ call_id: 'call-0' }))
		await runPostCallHooks(c.ctx(), [interestPingHook])
		expect(await c.eventsOf('voice_warm_lead_ping')).toHaveLength(0)
	})

	it('stays quiet when nobody flagged interest', async () => {
		const c = await newContact()
		await runPostCallHooks(c.ctx(), [interestPingHook])
		expect(await c.eventsOf('voice_warm_lead_ping')).toHaveLength(0)
	})
})
