import { describe, expect, it, vi } from 'vitest'
import {
	type DncGateDeps,
	type GateContact,
	checkEmailHookDenyList,
	erasureMarkerFor,
	normalizeDanishNumber,
	parseFounderActors,
	runDncGate,
} from '../../../lib/outreach/voice/dnc-gate'
import { parseErasureKey } from '../../../lib/outreach/voice/erasure-key'

// Thu 2026-10-01 11:00 CEST, inside the dial window.
const NOW = new Date('2026-10-01T09:00:00Z')
const SEBK_ID = '11111111-1111-4111-8111-111111111111'
const MAGNUS_ID = '22222222-2222-4222-8222-222222222222'
const FOUNDERS = JSON.stringify({ sebk: SEBK_ID, magnus: MAGNUS_ID })
const ERASURE_KEY = parseErasureKey('test-erasure-marker-key-0123456789-abcdef')

function contact(status: string, metadata: Record<string, unknown> = {}) {
	return { status, metadata }
}

function clean(overrides: Record<string, unknown> = {}, status = 'voice_queued'): GateContact {
	return {
		id: 'c1',
		status,
		metadata: { owner: 'sebk', phone: '+4520123456', company_type: 'aps', ...overrides },
	}
}

function deps(overrides: Partial<DncGateDeps> = {}): DncGateDeps {
	return {
		now: NOW,
		founders: parseFounderActors(FOUNDERS),
		findActor: async () => ({ type: 'human' }),
		erasure: ERASURE_KEY,
		matchesErasedContact: async () => false,
		matchesUnsweptErasedContact: async () => false,
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

	it('refuses metadata.protect and protect tags too, so the shared list matches the skill', () => {
		expect(checkEmailHookDenyList(contact('follow_up_later', { protect: true }))).toMatchObject({
			denied: true,
			check: 'protect',
		})
		expect(
			checkEmailHookDenyList(contact('follow_up_later', { tags: ['do-not-contact'] })),
		).toMatchObject({ denied: true, check: 'protect' })
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
		it('refuses metadata.protect true, the flag the sebastian-do-not-contact skill sets', async () => {
			const r = await refusal(clean({ protect: true }))
			expect(r).toMatchObject({ check: 'protect' })
			expect(r.reason).toContain('metadata.protect')
		})
		it.each(['protect', 'protected', 'do-not-contact', 'Do-Not-Contact'])(
			'refuses a contact tagged %s',
			async (tag) => {
				const r = await refusal(clean({ tags: ['vip', tag] }))
				expect(r).toMatchObject({ check: 'protect' })
				expect(r.reason).toContain('metadata.tags')
			},
		)
		it('does not refuse unrelated tags or protect set to false', async () => {
			expect(await runDncGate(clean({ tags: ['vip', 'nordic'], protect: false }), deps())).toEqual({
				pass: true,
			})
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

	describe('check 4: company type', () => {
		it.each(['aps', 'as'])('passes a contact whose company_type is %s', async (companyType) => {
			expect(await runDncGate(clean({ company_type: companyType }), deps())).toEqual({ pass: true })
		})
		it('refuses a contact with no company_type and says it is missing', async () => {
			const r = await refusal(clean({ company_type: undefined }))
			expect(r.check).toBe('company_type')
			expect(r.reason).toContain('missing')
		})
		it('refuses an empty company_type and says it is empty', async () => {
			const r = await refusal(clean({ company_type: '' }))
			expect(r.check).toBe('company_type')
			expect(r.reason).toContain('empty')
		})
		it.each(['enkeltmandsvirksomhed', 'enk', 'iv'])(
			'refuses the sole-proprietor-style value %s and names it',
			async (companyType) => {
				const r = await refusal(clean({ company_type: companyType }))
				expect(r.check).toBe('company_type')
				expect(r.reason).toContain(`"${companyType}"`)
			},
		)
		it.each(['aps ', 'APS', 'A/S', 'k/s', 'ivs'])(
			'refuses any other value (%s) and names it',
			async (companyType) => {
				const r = await refusal(clean({ company_type: companyType }))
				expect(r.check).toBe('company_type')
				expect(r.reason).toContain(`"${companyType}"`)
			},
		)
		it('refuses a company_type that is not a string and names it', async () => {
			const r = await refusal(clean({ company_type: 7 }))
			expect(r.check).toBe('company_type')
			expect(r.reason).toContain('"7"')
		})
		it('runs after the owner check and before the phone check', async () => {
			expect(await refusal(clean({ owner: undefined, company_type: undefined }))).toMatchObject({
				check: 'owner',
			})
			expect(await refusal(clean({ company_type: undefined, phone: undefined }))).toMatchObject({
				check: 'company_type',
			})
		})
	})

	describe('check 4b: +45 phone number', () => {
		it.each(['0045 20 12 34 56', '20123456', '(+45) 20-12-34-56'])(
			'passes a number that normalises to +45 (%s)',
			async (phone) => {
				expect(await runDncGate(clean({ phone }), deps())).toEqual({ pass: true })
			},
		)
		it.each([undefined, '', '12345', '+46701234567', 'not a number'])(
			'refuses when there is no valid +45 number (%s)',
			async (phone) => {
				const r = await refusal(clean({ phone }))
				expect(r.check).toBe('phone')
				expect(r.reason).toContain('+45')
			},
		)
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

	describe('check 7: erased contact', () => {
		const ERASED_NUMBER = '+4520123456'
		const erasedMarker = () => {
			if (!ERASURE_KEY.ok) throw new Error('test key must parse')
			return erasureMarkerFor(ERASED_NUMBER, ERASURE_KEY.key)
		}
		const lookup = (erased: Array<string | null>) =>
			vi.fn(async (marker: string) => erased.includes(marker))

		it('refuses a fresh contact whose number hashes to the marker of an erased contact', async () => {
			const matches = lookup([erasedMarker()])
			const c = clean({ phone: ERASED_NUMBER })
			const before = structuredClone(c)

			const r = await refusal(c, deps({ matchesErasedContact: matches }))

			expect(r).toEqual({ pass: false, check: 'erased', reason: 'matches erased contact' })
			expect(matches).toHaveBeenCalledTimes(1)
			// The refusal leaves the new contact exactly as it was.
			expect(c).toEqual(before)
		})

		it('passes a contact with a different number', async () => {
			const matches = lookup([erasedMarker()])
			expect(
				await runDncGate(clean({ phone: '+4520123457' }), deps({ matchesErasedContact: matches })),
			).toEqual({ pass: true })
			expect(matches).toHaveBeenCalledTimes(1)
		})

		it.each(['+4520123456', '+45 20 12 34 56', '0045 20123456', '20123456'])(
			'looks up the same marker when the number is written as %s',
			async (phone) => {
				const matches = lookup([])
				await runDncGate(clean({ phone }), deps({ matchesErasedContact: matches }))
				expect(matches).toHaveBeenCalledWith(erasedMarker())
			},
		)

		it('never puts the marker or the number in the refusal reason', async () => {
			const r = await refusal(
				clean({ phone: ERASED_NUMBER }),
				deps({ matchesErasedContact: lookup([erasedMarker()]) }),
			)
			expect(JSON.stringify(r)).not.toContain(erasedMarker() ?? 'unreachable')
			expect(JSON.stringify(r)).not.toContain('20123456')
		})

		it('refuses a row whose own metadata carries a marker, without a lookup', async () => {
			const matches = lookup([])
			const r = await refusal(
				clean({ erasure_marker: 'v1:abc', phone: '+4520999999' }),
				deps({ matchesErasedContact: matches }),
			)
			expect(r).toMatchObject({ check: 'erased', reason: 'matches erased contact' })
			expect(matches).not.toHaveBeenCalled()
		})

		it.each([undefined, '', '   ', 'too-short-for-a-key'])(
			'refuses every dial, with a reason naming the key, when the key is %j',
			async (raw) => {
				const matches = lookup([])
				const r = await refusal(
					clean(),
					deps({ erasure: parseErasureKey(raw), matchesErasedContact: matches }),
				)
				expect(r.check).toBe('erased')
				expect(r.reason).toContain('VOICE_ERASURE_MARKER_KEY')
				expect(matches).not.toHaveBeenCalled()
			},
		)

		it('refuses when the lookup fails', async () => {
			const r = await refusal(
				clean(),
				deps({
					matchesErasedContact: async () => {
						throw new Error('db down')
					},
				}),
			)
			expect(r).toMatchObject({ check: 'erased' })
			expect(r.reason).not.toContain('db down')
		})

		describe('sweep window (7c): an erased contact the sweep has not reached', () => {
			it('refuses a number that equals the stored number of an unswept erased contact', async () => {
				const unswept = vi.fn(async (e164: string) => e164 === ERASED_NUMBER)
				const c = clean({ phone: '0045 20123456' })
				const before = structuredClone(c)

				const r = await refusal(c, deps({ matchesUnsweptErasedContact: unswept }))

				expect(r).toEqual({ pass: false, check: 'erased', reason: 'matches erased contact' })
				expect(unswept).toHaveBeenCalledWith(ERASED_NUMBER)
				expect(c).toEqual(before)
			})

			it('passes a different number, and never puts the number in a refusal', async () => {
				const unswept = vi.fn(async (e164: string) => e164 === ERASED_NUMBER)
				expect(
					await runDncGate(
						clean({ phone: '+4520123457' }),
						deps({ matchesUnsweptErasedContact: unswept }),
					),
				).toEqual({ pass: true })
				const r = await refusal(
					clean({ phone: ERASED_NUMBER }),
					deps({ matchesUnsweptErasedContact: unswept }),
				)
				expect(JSON.stringify(r)).not.toContain('20123456')
			})

			it('is not asked when the marker already matched', async () => {
				const unswept = vi.fn(async () => true)
				await refusal(
					clean({ phone: ERASED_NUMBER }),
					deps({
						matchesErasedContact: lookup([erasedMarker()]),
						matchesUnsweptErasedContact: unswept,
					}),
				)
				expect(unswept).not.toHaveBeenCalled()
			})

			it('refuses when the lookup fails', async () => {
				const r = await refusal(
					clean(),
					deps({
						matchesUnsweptErasedContact: async () => {
							throw new Error('db down')
						},
					}),
				)
				expect(r).toMatchObject({ check: 'erased' })
				expect(r.reason).not.toContain('db down')
			})
		})

		it('runs after the other checks, so an earlier refusal wins', async () => {
			const matches = lookup([erasedMarker()])
			const r = await refusal(
				clean({ dial_attempt_n: 3 }, 'voice_busy'),
				deps({ matchesErasedContact: matches }),
			)
			expect(r).toMatchObject({ check: 'max_dials' })
			expect(matches).not.toHaveBeenCalled()
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
