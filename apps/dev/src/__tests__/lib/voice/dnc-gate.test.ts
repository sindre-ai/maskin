import { describe, expect, it } from 'vitest'
import {
	type DncGateDeps,
	type GateContact,
	checkEmailHookDenyList,
	normalizeDanishNumber,
	parseFounderActors,
	runDncGate,
} from '../../../lib/outreach/voice/dnc-gate'

// Thu 2026-10-01 11:00 CEST, inside the dial window.
const NOW = new Date('2026-10-01T09:00:00Z')
const SEBK_ID = '11111111-1111-4111-8111-111111111111'
const MAGNUS_ID = '22222222-2222-4222-8222-222222222222'
const FOUNDERS = JSON.stringify({ sebk: SEBK_ID, magnus: MAGNUS_ID })

function contact(status: string, metadata: Record<string, unknown> = {}) {
	return { status, metadata }
}

function clean(overrides: Record<string, unknown> = {}, status = 'voice_queued'): GateContact {
	return {
		id: 'c1',
		status,
		metadata: { owner: 'sebk', phone: '+4520123456', ...overrides },
	}
}

function deps(overrides: Partial<DncGateDeps> = {}): DncGateDeps {
	return {
		now: NOW,
		founders: parseFounderActors(FOUNDERS),
		findActor: async () => ({ type: 'human' }),
		robinson: { has: () => false },
		...overrides,
	}
}

async function refusal(c: GateContact, d: DncGateDeps = deps()) {
	const result = await runDncGate(c, d)
	if (result.pass) throw new Error('expected a refusal')
	return result
}

describe('checkEmailHookDenyList (shared email-hook deny list)', () => {
	it('does not refuse a contact that ended the call on follow_up_later with a quote on record', () => {
		const c = contact('follow_up_later', {
			voice_tool_trace: [{ tool_name: 'request_followup_email' }],
			consent_quote: 'yes, send it',
		})
		expect(checkEmailHookDenyList(c)).toEqual({ denied: false })
	})

	it('does not refuse voice_declined or a booked contact either (not the generic suppressing set)', () => {
		expect(checkEmailHookDenyList(contact('voice_declined')).denied).toBe(false)
		expect(checkEmailHookDenyList(contact('voice_meeting_booked')).denied).toBe(false)
	})

	it('refuses a contact with metadata.approval_hold set', () => {
		const v = checkEmailHookDenyList(contact('follow_up_later', { approval_hold: { by: 'sebk' } }))
		expect(v).toMatchObject({ denied: true, check: 'hold' })
		expect(v.denied && v.reason).toContain('approval_hold')
	})

	it('refuses a contact with metadata.held_reason set', () => {
		const v = checkEmailHookDenyList(contact('follow_up_later', { held_reason: 'legal review' }))
		expect(v).toMatchObject({ denied: true, check: 'hold' })
		expect(v.denied && v.reason).toContain('held_reason')
	})

	it('refuses a protected contact', () => {
		const v = checkEmailHookDenyList(contact('follow_up_later', { protected: true }))
		expect(v).toMatchObject({ denied: true, check: 'protect' })
	})

	it.each(['deleted_by_request', 'rejected'])('refuses a %s contact', (status) => {
		const v = checkEmailHookDenyList(contact(status))
		expect(v).toMatchObject({ denied: true, check: 'status' })
		expect(v.denied && v.reason).toContain(status)
	})

	it('treats an unset or false hold marker as no hold', () => {
		expect(
			checkEmailHookDenyList(contact('follow_up_later', { approval_hold: false })).denied,
		).toBe(false)
		expect(checkEmailHookDenyList(contact('follow_up_later', { held_reason: '' })).denied).toBe(
			false,
		)
		expect(checkEmailHookDenyList({ status: 'follow_up_later', metadata: null }).denied).toBe(false)
	})
})

describe('runDncGate', () => {
	it('passes a clean founder-owned contact in the window', async () => {
		expect(await runDncGate(clean(), deps())).toEqual({ pass: true })
	})

	describe('check 1: hold', () => {
		it('refuses on approval_hold', async () => {
			expect(await refusal(clean({ approval_hold: true }))).toMatchObject({ check: 'hold' })
		})
		it('refuses on held_reason', async () => {
			expect(await refusal(clean({ held_reason: 'wait' }))).toMatchObject({ check: 'hold' })
		})
	})

	describe('check 2: suppressing status', () => {
		it.each(['voice_declined', 'follow_up_later', 'deleted_by_request', 'rejected'])(
			'refuses %s with a legible reason',
			async (status) => {
				const r = await refusal(clean({}, status))
				expect(r.check).toBe('status')
				expect(r.reason).toContain(status)
			},
		)

		it('refuses follow_up_later in the dialer while the shared deny list passes the same contact', async () => {
			const c = clean({}, 'follow_up_later')
			expect(await refusal(c)).toMatchObject({ check: 'status' })
			expect(checkEmailHookDenyList(c)).toEqual({ denied: false })
		})

		it.each(['voice_queued', 'voice_no_answer', 'voice_busy', 'voice_voicemail'])(
			'does not refuse the queue status %s',
			async (status) => {
				expect(await runDncGate(clean({}, status), deps())).toEqual({ pass: true })
			},
		)
	})

	describe('skill-rule mirror', () => {
		it('refuses a protected contact', async () => {
			expect(await refusal(clean({ protected: true }))).toMatchObject({ check: 'protect' })
		})
		it('refuses role investor', async () => {
			expect(await refusal(clean({ role: 'investor' }))).toMatchObject({ check: 'investor' })
		})
		it('refuses the investor_pipeline lead source', async () => {
			expect(await refusal(clean({ lead_source: 'investor_pipeline' }))).toMatchObject({
				check: 'investor',
			})
		})
	})

	describe('check 3: founder-owned', () => {
		it('passes for a second founder slug', async () => {
			expect(await runDncGate(clean({ owner: 'magnus' }), deps())).toEqual({ pass: true })
		})
		it('refuses an unowned contact', async () => {
			expect(await refusal(clean({ owner: undefined }))).toMatchObject({ check: 'owner' })
		})
		it.each(['rune', 'unassigned', 'someone-else'])('refuses owner slug %s', async (owner) => {
			const r = await refusal(clean({ owner }))
			expect(r.check).toBe('owner')
			expect(r.reason).toContain('not a founder')
		})
		it('refuses when the mapped actor row no longer exists', async () => {
			const r = await refusal(clean(), deps({ findActor: async () => null }))
			expect(r).toMatchObject({ check: 'owner' })
			expect(r.reason).toContain('no longer exists')
		})
		it('refuses when the mapped actor is not human', async () => {
			const r = await refusal(clean(), deps({ findActor: async () => ({ type: 'agent' }) }))
			expect(r.reason).toContain('not a human')
		})
		it('refuses when the actor lookup throws', async () => {
			const r = await refusal(
				clean(),
				deps({
					findActor: async () => {
						throw new Error('db down')
					},
				}),
			)
			expect(r).toMatchObject({ check: 'owner' })
		})
		it.each([
			['missing', undefined],
			['empty', ''],
			['not json', 'sebk'],
			['empty map', '{}'],
			['bare id list', `["${SEBK_ID}"]`],
			['non-uuid actor id', '{"sebk":"abc"}'],
		])('fails closed with a legible reason when the env is %s', async (_name, raw) => {
			const r = await refusal(clean(), deps({ founders: parseFounderActors(raw) }))
			expect(r.check).toBe('owner')
			expect(r.reason).toContain('VOICE_FOUNDER_ACTORS')
		})
		it('does not resolve inherited object keys as founders', async () => {
			const r = await refusal(clean({ owner: 'constructor' }))
			expect(r.reason).toContain('not a founder')
		})
	})

	describe('check 4: Robinson list', () => {
		it('refuses a listed number and stamps robinson_listed_at', async () => {
			const r = await refusal(clean(), deps({ robinson: { has: (n) => n === '+4520123456' } }))
			expect(r).toMatchObject({
				check: 'robinson',
				stamp: { robinson_listed_at: NOW.toISOString() },
			})
		})
		it('normalises the number before the lookup', async () => {
			const seen: string[] = []
			await runDncGate(
				clean({ phone: '0045 20 12 34 56' }),
				deps({
					robinson: {
						has: (n) => {
							seen.push(n)
							return false
						},
					},
				}),
			)
			expect(seen).toEqual(['+4520123456'])
		})
		it.each([undefined, '', '12345', '+46701234567', 'not a number'])(
			'refuses when there is no valid +45 number (%s)',
			async (phone) => {
				expect(await refusal(clean({ phone }))).toMatchObject({ check: 'robinson' })
			},
		)
		it('fails closed when the list is unavailable', async () => {
			const r = await refusal(
				clean(),
				deps({
					robinson: {
						has: () => {
							throw new Error('no csv')
						},
					},
				}),
			)
			expect(r).toMatchObject({ check: 'robinson' })
			expect(r.reason).toContain('unavailable')
		})
	})

	describe('check 5: time of day', () => {
		it.each([
			['before 09:00', '2026-10-01T06:59:00Z'],
			['at 16:00', '2026-10-01T14:00:00Z'],
			['on a Saturday', '2026-10-03T09:00:00Z'],
			['on a Sunday', '2026-10-04T09:00:00Z'],
		])('refuses %s Copenhagen time', async (_name, iso) => {
			expect(await refusal(clean(), deps({ now: new Date(iso) }))).toMatchObject({
				check: 'time_of_day',
			})
		})
		it('passes at 09:00 and at 15:59', async () => {
			expect(await runDncGate(clean(), deps({ now: new Date('2026-10-01T07:00:00Z') }))).toEqual({
				pass: true,
			})
			expect(await runDncGate(clean(), deps({ now: new Date('2026-10-01T13:59:00Z') }))).toEqual({
				pass: true,
			})
		})
	})

	describe('check 6: max dials', () => {
		it('refuses a contact already dialed 3 times', async () => {
			expect(await refusal(clean({ dial_attempt_n: 3 }, 'voice_busy'))).toMatchObject({
				check: 'max_dials',
			})
		})
		it('passes a contact dialed twice', async () => {
			expect(await runDncGate(clean({ dial_attempt_n: 2 }, 'voice_busy'), deps())).toEqual({
				pass: true,
			})
		})
	})

	it('reports the first failing check when several fail', async () => {
		const c = clean({ approval_hold: true, protected: true, dial_attempt_n: 9 }, 'rejected')
		expect(await refusal(c)).toMatchObject({ check: 'hold' })
	})
})

describe('normalizeDanishNumber', () => {
	it.each([
		['+4520123456', '+4520123456'],
		['20123456', '+4520123456'],
		['+45 20 12 34 56', '+4520123456'],
		['0045-20123456', '+4520123456'],
		['(+45) 20.12.34.56', '+4520123456'],
	])('%s -> %s', (raw, expected) => {
		expect(normalizeDanishNumber(raw)).toBe(expected)
	})
	it.each([null, undefined, 42, '', '+4620123456', '2012345', '+45201234567'])(
		'rejects %s',
		(raw) => {
			expect(normalizeDanishNumber(raw)).toBeNull()
		},
	)
})
