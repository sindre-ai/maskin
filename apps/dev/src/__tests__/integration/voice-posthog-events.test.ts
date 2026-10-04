import { generateKeyPairSync, sign } from 'node:crypto'
import { integrations, objects } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { capturePosthogEvent } from '../../lib/analytics/posthog'
import { encrypt } from '../../lib/crypto'
import { encodeClientState } from '../../lib/integrations/providers/telnyx/client'
import { logger } from '../../lib/logger'
import { recordToolSuccess } from '../../lib/outreach/voice/apply'
import type { EffectRunner } from '../../lib/outreach/voice/effects'
import { VOICE_CALL_COMPLETED_KEY } from '../../lib/outreach/voice/posthog-events'
import telnyxWebhookRoutes, {
	setEffectRunnerForTests,
} from '../../routes/integrations-telnyx-webhook'
import { insertObject, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// The five voice PostHog events, driven through the real webhook route and the
// real post-call hook list on real Postgres. Only the PostHog capture helper
// (the spy) and global fetch under the Resend SDK are replaced.
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn() }))
const capture = vi.mocked(capturePosthogEvent)
const fetchMock = vi.fn()

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PATH = '/api/integrations/telnyx/webhook'

let savedKey: string | undefined
beforeAll(() => {
	savedKey = process.env.TELNYX_PUBLIC_KEY
	process.env.TELNYX_PUBLIC_KEY = publicKey
		.export({ format: 'der', type: 'spki' })
		.subarray(-32)
		.toString('base64')
})
afterAll(() => {
	if (savedKey === undefined) Reflect.deleteProperty(process.env, 'TELNYX_PUBLIC_KEY')
	else process.env.TELNYX_PUBLIC_KEY = savedKey
	setEffectRunnerForTests(null)
})

const noopRunner: EffectRunner = {
	sendSms: async () => {},
	hangupCall: async () => {},
	deadLetter: async () => {},
}

beforeEach(() => {
	capture.mockReset()
	capture.mockResolvedValue(undefined)
	fetchMock.mockReset()
	fetchMock.mockImplementation(
		async () => new Response(JSON.stringify({ id: 'email_1' }), { status: 200 }),
	)
	vi.stubGlobal('fetch', fetchMock)
	setEffectRunnerForTests(noopRunner)
})
afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

let n = 0
function envelope(eventType: string, payload: Record<string, unknown>, eventId?: string) {
	n++
	return JSON.stringify({
		data: {
			id: eventId ?? `evt-ph-${Date.now()}-${n}-${Math.random().toString(36).slice(2, 8)}`,
			event_type: eventType,
			occurred_at: new Date().toISOString(),
			payload,
		},
	})
}

function post(body: string) {
	const ts = Math.floor(Date.now() / 1000)
	return createIntegrationApp({ path: PATH, module: telnyxWebhookRoutes }).request(PATH, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'telnyx-timestamp': String(ts),
			'telnyx-signature-ed25519': sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString(
				'base64',
			),
		},
		body,
	})
}

async function connectResend(workspaceId: string) {
	await db.insert(integrations).values({
		workspaceId,
		provider: 'resend',
		status: 'active',
		credentials: encrypt(JSON.stringify({ accessToken: 're_key_ph' })),
		config: { resend: { send_from: 'noreply@agent.ph.example' } },
		createdBy: getTestActorId(),
	})
}

const DISCLOSED_TRANSCRIPT = [
	{ role: 'assistant', text: 'Hej, I am an AI assistant calling on behalf of Maskin.' },
	{ role: 'user', text: 'Okay, go on.' },
]

async function newCall(
	opts: { resend?: boolean; metadata?: Record<string, unknown>; callId?: string } = {},
) {
	const ws = await insertWorkspace(db, getTestActorId())
	if (opts.resend !== false) await connectResend(ws.id)
	const contact = await insertObject(db, ws.id, getTestActorId(), {
		type: 'contact',
		title: 'Pia Prospect',
		status: 'voice_queued',
		metadata: { email: 'pia@prospect.example', ...opts.metadata },
	})
	const callId = opts.callId ?? `call-ph-${Math.random().toString(36).slice(2, 8)}`
	const state = encodeClientState({
		contact_id: contact.id,
		workspace_id: ws.id,
		dial_attempt_n: 1,
	})
	// A hangup carries a transcript whose first agent turn discloses the AI, as a real call does;
	// without one the disclosure assertion hook flags the call and the email is skipped.
	const body = (type: string, extra: Record<string, unknown> = {}, eventId?: string) =>
		envelope(
			type,
			{
				call_control_id: callId,
				client_state: state,
				to: '+4511111111',
				from: '+4522222222',
				...(type === 'call.hangup' ? { transcript: DISCLOSED_TRANSCRIPT } : {}),
				...extra,
			},
			eventId,
		)
	const send = (type: string, extra: Record<string, unknown> = {}, eventId?: string) =>
		post(body(type, extra, eventId))
	// The tool router is not mounted here; it writes the trace through recordToolSuccess once a tool
	// succeeded (the webhook no longer does), so the helper records a successful tool the same way.
	const tool = async (toolName: string) => {
		await recordToolSuccess(db, {
			workspaceId: ws.id,
			contactId: contact.id,
			callId,
			toolName,
		})
	}
	// An event on a transfer's Leg B: its own call id, client_state naming Leg A (transfer_of).
	const sendLegB = (type: string, legB: string, extra: Record<string, unknown> = {}) =>
		post(
			envelope(type, {
				call_control_id: legB,
				client_state: encodeClientState({
					contact_id: contact.id,
					workspace_id: ws.id,
					dial_attempt_n: 1,
					transfer_of: callId,
				}),
				to: '+4533333333',
				from: '+4522222222',
				...extra,
			}),
		)
	return { contactId: contact.id, send, body, tool, sendLegB }
}

const captured = () =>
	capture.mock.calls.map(([event, distinctId, props]) => ({
		event,
		distinctId,
		props,
	}))
const names = () => captured().map((c) => c.event)

describe('voice PostHog events: the spec walk', () => {
	it('fires all five with exact names and properties, in order, keyed on the contact', async () => {
		const c = await newCall()
		await c.send('call.initiated')
		await c.send('call.answered')
		await c.tool('confirm_meeting_slot')
		await c.tool('request_followup_email')
		const res = await c.send('call.hangup', { hangup_cause: 'normal_clearing', duration_s: 187 })
		expect(res.status).toBe(200)

		expect(captured()).toEqual([
			{ event: 'call_initiated', distinctId: c.contactId, props: {} },
			{ event: 'call_answered', distinctId: c.contactId, props: {} },
			{
				event: 'call_completed',
				distinctId: c.contactId,
				props: { outcome: 'answered', duration_seconds: 187, channel: 'voice_agent' },
			},
			{
				event: 'meeting_booked',
				distinctId: c.contactId,
				props: { source: 'voice_agent', contact_id: c.contactId },
			},
			{
				event: 'post_call_email_sent',
				distinctId: c.contactId,
				props: { compliance_basis: 'legitimate_interest' },
			},
		])
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})
})

describe('voice PostHog events: negative cases', () => {
	it('a replayed webhook event (same event_id) does not double-fire anything', async () => {
		const c = await newCall()
		const initiated = c.body('call.initiated', {}, 'evt-ph-dup-init')
		await post(initiated)
		await post(initiated)
		await c.send('call.answered', {}, 'evt-ph-dup-ans')
		await c.send('call.answered', {}, 'evt-ph-dup-ans')
		await c.tool('request_followup_email')
		const hangup = c.body(
			'call.hangup',
			{ hangup_cause: 'normal_clearing', duration_s: 60 },
			'evt-ph-dup-hup',
		)
		await post(hangup)
		const replay = await post(hangup)
		expect(await replay.json()).toMatchObject({ duplicate: true })

		expect(names()).toEqual([
			'call_initiated',
			'call_answered',
			'call_completed',
			'post_call_email_sent',
		])
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('a repeat of the same call under a new event_id adds no call_initiated or call_answered', async () => {
		const c = await newCall()
		await c.send('call.initiated')
		await c.send('call.initiated')
		await c.send('call.answered')
		await c.send('call.answered')
		expect(names()).toEqual(['call_initiated', 'call_answered'])
	})

	it('no connected leg: call_completed is no_answer with duration 0, no call_answered, no email', async () => {
		const c = await newCall()
		await c.send('call.initiated')
		await c.send('call.hangup', { hangup_cause: 'no_answer', duration_s: 31 })
		expect(captured()).toEqual([
			{ event: 'call_initiated', distinctId: c.contactId, props: {} },
			{
				event: 'call_completed',
				distinctId: c.contactId,
				props: { outcome: 'no_answer', duration_seconds: 0, channel: 'voice_agent' },
			},
		])
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('a busy line is no_answer with duration 0', async () => {
		const c = await newCall()
		await c.send('call.initiated')
		await c.send('call.hangup', { hangup_cause: 'busy' })
		expect(captured().at(-1)?.props).toEqual({
			outcome: 'no_answer',
			duration_seconds: 0,
			channel: 'voice_agent',
		})
	})

	it('a machine pickup is voicemail, whether the verdict or the hangup cause got there first', async () => {
		const viaVerdict = await newCall()
		await viaVerdict.send('call.initiated')
		await viaVerdict.send('call.answered')
		await viaVerdict.send('call.machine.premium.detection.ended', { result: 'machine' })
		await viaVerdict.send('call.hangup', { hangup_cause: 'normal_clearing', duration_s: 9 })
		const verdictCompleted = captured().filter((e) => e.event === 'call_completed')
		expect(verdictCompleted.map((e) => e.props)).toEqual([
			{ outcome: 'voicemail', duration_seconds: 9, channel: 'voice_agent' },
		])

		capture.mockClear()
		const viaCause = await newCall()
		await viaCause.send('call.initiated')
		await viaCause.send('call.answered')
		await viaCause.send('call.hangup', { hangup_cause: 'machine_detected', duration_s: 7 })
		expect(captured().filter((e) => e.event === 'call_completed')[0]?.props).toEqual({
			outcome: 'voicemail',
			duration_seconds: 7,
			channel: 'voice_agent',
		})
		expect(names()).not.toContain('post_call_email_sent')
		expect(names()).not.toContain('meeting_booked')
	})

	it('a connected call with no request_followup_email in the trace: answered, no email event', async () => {
		const c = await newCall()
		await c.send('call.initiated')
		await c.send('call.answered')
		await c.tool('end_call_polite')
		await c.send('call.hangup', { hangup_cause: 'normal_clearing', duration_s: 44 })
		expect(names()).toEqual(['call_initiated', 'call_answered', 'call_completed'])
		expect(captured().at(-1)?.props).toEqual({
			outcome: 'answered',
			duration_seconds: 44,
			channel: 'voice_agent',
		})
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('follow_up_later counts as answered and does not fire meeting_booked', async () => {
		const c = await newCall()
		await c.send('call.initiated')
		await c.send('call.answered')
		await c.tool('request_followup_email')
		await c.send('call.hangup', { hangup_cause: 'normal_clearing', duration_s: 120 })
		expect(names()).toEqual([
			'call_initiated',
			'call_answered',
			'call_completed',
			'post_call_email_sent',
		])
		expect(captured()[2]?.props).toMatchObject({ outcome: 'answered', duration_seconds: 120 })
	})

	it('a warm transfer counts as answered even though the hangup is absorbed', async () => {
		const c = await newCall()
		await c.send('call.initiated')
		await c.send('call.answered')
		await c.sendLegB('call.answered', 'leg-b-ph')
		await c.send('call.hangup', { hangup_cause: 'normal_clearing', duration_s: 95 })
		expect(captured().at(-1)).toEqual({
			event: 'call_completed',
			distinctId: c.contactId,
			props: { outcome: 'answered', duration_seconds: 95, channel: 'voice_agent' },
		})
		expect(names()).not.toContain('meeting_booked')
		expect(names().filter((e) => e === 'call_answered')).toHaveLength(1)
	})

	it('a transfer Leg B answer, bridge and hangup fire nothing: they are not the prospect call', async () => {
		const c = await newCall()
		await c.send('call.initiated')
		await c.send('call.answered')
		capture.mockClear()
		await c.sendLegB('call.initiated', 'leg-b-x')
		await c.sendLegB('call.answered', 'leg-b-x')
		await c.sendLegB('call.bridged', 'leg-b-x')
		await c.sendLegB('call.hangup', 'leg-b-x', { hangup_cause: 'timeout', duration_s: 12 })
		expect(captured()).toEqual([])
		// Leg A's own hangup is still the one call_completed.
		await c.send('call.hangup', { hangup_cause: 'normal_clearing', duration_s: 95 })
		expect(captured()).toEqual([
			{
				event: 'call_completed',
				distinctId: c.contactId,
				props: { outcome: 'answered', duration_seconds: 95, channel: 'voice_agent' },
			},
		])
	})

	it('meeting_booked and call_completed fire once when a second hangup arrives under a new event_id', async () => {
		const c = await newCall()
		await c.send('call.initiated')
		await c.send('call.answered')
		await c.tool('confirm_meeting_slot')
		await c.send('call.hangup', { hangup_cause: 'normal_clearing', duration_s: 80 })
		await c.send('call.hangup', { hangup_cause: 'normal_clearing', duration_s: 80 })
		expect(names().filter((e) => e === 'meeting_booked')).toHaveLength(1)
		expect(names().filter((e) => e === 'call_completed')).toHaveLength(1)
	})

	it('two concurrent hangups for one call fire call_completed once', async () => {
		const c = await newCall()
		await c.send('call.initiated')
		await c.send('call.answered')
		const hangup = { hangup_cause: 'normal_clearing', duration_s: 55 }
		const [a, b] = await Promise.all([c.send('call.hangup', hangup), c.send('call.hangup', hangup)])
		expect([a.status, b.status]).toEqual([200, 200])
		expect(names().filter((e) => e === 'call_completed')).toHaveLength(1)
	})

	it('stamps the completed call id on the contact, so a later call id would fire again', async () => {
		const c = await newCall({ callId: 'call-ph-stamp' })
		await c.send('call.initiated')
		await c.send('call.answered')
		await c.send('call.hangup', { hangup_cause: 'normal_clearing', duration_s: 12 })
		const [row] = await db.select().from(objects).where(eq(objects.id, c.contactId))
		expect((row.metadata as Record<string, unknown>)[VOICE_CALL_COMPLETED_KEY]).toBe(
			'call-ph-stamp',
		)
	})

	it('a hangup for a different call than the contact is on fires no call_completed', async () => {
		const c = await newCall()
		await c.send('call.initiated')
		// Same contact, an older call id.
		await post(
			c.body('call.hangup', {
				call_control_id: 'some-older-call',
				hangup_cause: 'normal_clearing',
			}),
		)
		expect(names()).toEqual(['call_initiated'])
	})

	describe('post_call_email_sent never fires on a skipped email', () => {
		const finish = async (c: Awaited<ReturnType<typeof newCall>>) => {
			await c.send('call.initiated')
			await c.send('call.answered')
			await c.tool('request_followup_email')
			const res = await c.send('call.hangup', { hangup_cause: 'normal_clearing', duration_s: 70 })
			expect(res.status).toBe(200)
		}

		it('no_resend_integration', async () => {
			const c = await newCall({ resend: false })
			await finish(c)
			expect(names()).toEqual(['call_initiated', 'call_answered', 'call_completed'])
			expect(fetchMock).not.toHaveBeenCalled()
		})

		it('disclosure_missing', async () => {
			const c = await newCall({ metadata: { compliance_flag: 'disclosure_missing' } })
			await finish(c)
			expect(names()).not.toContain('post_call_email_sent')
			expect(names()).toContain('call_completed')
		})

		it('missing address on the contact', async () => {
			const c = await newCall({ metadata: { email: '' } })
			await finish(c)
			expect(names()).not.toContain('post_call_email_sent')
			expect(fetchMock).not.toHaveBeenCalled()
		})

		it('an email already sent for this call (retried hangup under a new event_id)', async () => {
			const c = await newCall()
			await finish(c)
			capture.mockClear()
			await c.send('call.hangup', { hangup_cause: 'normal_clearing', duration_s: 70 })
			expect(names()).not.toContain('post_call_email_sent')
			expect(fetchMock).toHaveBeenCalledTimes(1)
		})
	})
})

describe('voice PostHog events: capture failure never reaches the webhook', () => {
	it('a throwing capture still answers 200 and logs; state, hooks and the email carry on', async () => {
		const warn = vi.spyOn(logger, 'warn')
		capture.mockImplementation(() => {
			throw new Error('posthog exploded')
		})
		const c = await newCall()
		expect((await c.send('call.initiated')).status).toBe(200)
		expect((await c.send('call.answered')).status).toBe(200)
		await c.tool('request_followup_email')
		const res = await c.send('call.hangup', { hangup_cause: 'normal_clearing', duration_s: 187 })
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ ok: true, status: 'follow_up_later', applied: true })
		// The email still went out, and each failure was logged.
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const logged = warn.mock.calls.filter(([msg]) => msg === 'voice posthog capture failed')
		expect(logged.map(([, ctx]) => (ctx as { event: string }).event)).toEqual([
			'call_initiated',
			'call_answered',
			'call_completed',
			'post_call_email_sent',
		])
	})

	it('a rejecting capture is logged and does not fail the webhook', async () => {
		const warn = vi.spyOn(logger, 'warn')
		capture.mockRejectedValue(new Error('posthog 500'))
		const c = await newCall()
		expect((await c.send('call.initiated')).status).toBe(200)
		await vi.waitFor(() =>
			expect(warn).toHaveBeenCalledWith(
				'voice posthog capture failed',
				expect.objectContaining({ event: 'call_initiated', error: 'posthog 500' }),
			),
		)
	})
})
