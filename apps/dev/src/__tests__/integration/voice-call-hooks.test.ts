import { events, objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
	createDisclosureHook,
	firstAgentUtterance,
	registerVoiceCallHooks,
	warmInterestHook,
} from '../../lib/outreach/voice/call-hooks'
import type { PostCallContext, PostCallHook } from '../../lib/outreach/voice/post-call'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

async function setup(metadata: Record<string, unknown> = {}) {
	const ws = await insertWorkspace(db, getTestActorId())
	const contact = await insertObject(db, ws.id, getTestActorId(), {
		type: 'contact',
		status: 'voice_answered',
		metadata: { last_call_id: 'call-1', ...metadata },
	})
	const ctx = (over: Partial<PostCallContext> = {}): PostCallContext => ({
		db,
		workspaceId: ws.id,
		contactId: contact.id,
		callId: 'call-1',
		status: 'voice_declined',
		hangupCause: 'normal_clearing',
		durationS: 40,
		recordingUrl: 'https://rec.test/1.mp3',
		transcriptUrl: null,
		...over,
	})
	const meta = async () => {
		const [row] = await db.select().from(objects).where(eq(objects.id, contact.id))
		return (row?.metadata ?? {}) as Record<string, unknown>
	}
	const pings = () =>
		db
			.select()
			.from(events)
			.where(and(eq(events.entityId, contact.id), eq(events.action, 'voice_sales_ping')))
	return { ctx, meta, pings }
}

const turns = (agent: string) => [
	{ role: 'assistant', text: agent },
	{ role: 'user', text: 'Hello?' },
]

describe('disclosure assertion hook', () => {
	const hook = createDisclosureHook(async () => {
		throw new Error('no fetch in tests')
	})

	it('passes when the first agent utterance names an AI assistant, in English or Danish', async () => {
		for (const line of [
			'Hi Anna, this is an AI assistant calling on behalf of Maskin, do you have a moment?',
			'Hej Anna, det her er en AI-assistent, der ringer på vegne af Maskin, har du et øjeblik?',
		]) {
			const t = await setup()
			await hook.run(t.ctx({ transcript: turns(line) }))
			expect((await t.meta()).compliance_flag).toBeUndefined()
			expect(await t.pings()).toHaveLength(0)
		}
	})

	it('stamps disclosure_missing and pings #sales at Attention 5 when the opener does not say it', async () => {
		const t = await setup()
		await hook.run(t.ctx({ transcript: turns('Hi Anna, I wanted to tell you about Maskin.') }))
		expect((await t.meta()).compliance_flag).toBe('disclosure_missing')
		const [ping] = await t.pings()
		expect(ping?.data).toMatchObject({
			attention: 5,
			channel: '#sales',
			reason: 'disclosure_missing',
		})
	})

	it('reads only the first agent turn: a later mention does not rescue a missing opener', async () => {
		const t = await setup()
		await hook.run(
			t.ctx({
				transcript: [
					{ role: 'assistant', text: 'Hi Anna, quick question.' },
					{ role: 'assistant', text: 'By the way I am an AI assistant.' },
				],
			}),
		)
		expect((await t.meta()).compliance_flag).toBe('disclosure_missing')
	})

	it('fails closed on a connected call with no readable transcript', async () => {
		const t = await setup()
		await hook.run(t.ctx())
		expect((await t.meta()).compliance_flag).toBe('disclosure_missing')
		expect((await t.pings())[0]?.data).toMatchObject({ transcript_available: false })
	})

	it('does nothing for a call that never reached the agent', async () => {
		for (const status of ['voice_no_answer', 'voice_busy', 'voice_voicemail', 'voice_failed']) {
			const t = await setup()
			await hook.run(t.ctx({ status }))
			expect((await t.meta()).compliance_flag).toBeUndefined()
		}
		const t = await setup()
		await hook.run(t.ctx({ durationS: 0 }))
		expect((await t.meta()).compliance_flag).toBeUndefined()
	})

	it('does not flag a contact that is already on a newer call', async () => {
		const t = await setup({ last_call_id: 'call-2' })
		await hook.run(t.ctx({ transcript: turns('Hello there.') }))
		expect((await t.meta()).compliance_flag).toBeUndefined()
		expect(await t.pings()).toHaveLength(0)
	})

	it('reads a transcript from its URL when none came inline', async () => {
		const fetched = createDisclosureHook(async () => ({
			turns: turns('Hi, this is an AI assistant calling for Maskin.'),
		}))
		const t = await setup()
		await fetched.run(t.ctx({ transcriptUrl: 'https://t.test/1.json' }))
		expect((await t.meta()).compliance_flag).toBeUndefined()
	})
})

describe('firstAgentUtterance', () => {
	it('finds the first agent turn across common shapes, and null otherwise', () => {
		expect(
			firstAgentUtterance([
				{ role: 'user', text: 'x' },
				{ role: 'agent', content: 'hi' },
			]),
		).toBe('hi')
		expect(firstAgentUtterance({ messages: [{ speaker: 'assistant', transcript: 'yo' }] })).toBe(
			'yo',
		)
		expect(firstAgentUtterance([{ role: 'user', text: 'only me' }])).toBeNull()
		expect(firstAgentUtterance('plain string')).toBeNull()
		expect(firstAgentUtterance(null)).toBeNull()
	})
})

describe('warm interest hook', () => {
	it('pings #sales at Attention 4 with the recording and transcript links and the phone', async () => {
		const t = await setup({
			phone: '+4512345678',
			voice_interest: { call_id: 'call-1', strength: 'warm', reason: 'send more' },
		})
		await warmInterestHook.run(t.ctx({ transcriptUrl: 'https://t.test/1.json' }))
		const [ping] = await t.pings()
		expect(ping?.data).toMatchObject({
			attention: 4,
			channel: '#sales',
			recording_url: 'https://rec.test/1.mp3',
			transcript_url: 'https://t.test/1.json',
			prospect_phone: '+4512345678',
		})
	})

	it('stays quiet for hot interest, for another call, and for no interest', async () => {
		for (const interest of [
			{ call_id: 'call-1', strength: 'hot', reason: 'x' },
			{ call_id: 'older', strength: 'warm', reason: 'x' },
			undefined,
		]) {
			const t = await setup({ voice_interest: interest })
			await warmInterestHook.run(t.ctx())
			expect(await t.pings()).toHaveLength(0)
		}
	})
})

describe('registerVoiceCallHooks', () => {
	it('puts the disclosure assertion first, whatever was registered before, and is idempotent', () => {
		const hooks: PostCallHook[] = [{ name: 'email', run: () => {} }]
		registerVoiceCallHooks(hooks)
		registerVoiceCallHooks(hooks)
		expect(hooks.map((h) => h.name)).toEqual([
			'disclosure_assertion',
			'email',
			'warm_interest_ping',
		])
	})
})
