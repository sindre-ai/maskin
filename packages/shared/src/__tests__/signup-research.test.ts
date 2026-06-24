import { describe, expect, it } from 'vitest'
import { createObjectSchema, updateObjectSchema } from '../schemas/objects'
import {
	CONFIDENCE_ROUTING_THRESHOLD,
	LONG_STALENESS_CLASS,
	SHORT_STALENESS_CLASS,
	SIGNUP_RESEARCH_SOURCE,
	bucketConfidence,
	buildInvalidationPatch,
	buildSignupResearchKnowledge,
	isValidAt,
	signupResearchInputSchema,
	statusForConfidence,
} from '../schemas/signup-research'

const baseInput = {
	claim: 'Acme raised a $12M Series A in 2026-01.',
	source: 'https://techcrunch.com/2026/01/15/acme-series-a',
	confidenceScore: 0.9,
	stalenessClass: SHORT_STALENESS_CLASS,
	validFrom: '2026-01-15T00:00:00.000Z',
	title: 'Acme — $12M Series A (Jan 2026)',
	content: 'Acme raised $12M led by Sequoia in January 2026. Source: TechCrunch.',
}

describe('signupResearchInputSchema', () => {
	it('accepts a complete payload', () => {
		expect(() => signupResearchInputSchema.parse(baseInput)).not.toThrow()
	})

	it('rejects confidence_score outside [0,1]', () => {
		expect(() => signupResearchInputSchema.parse({ ...baseInput, confidenceScore: 1.1 })).toThrow()
		expect(() => signupResearchInputSchema.parse({ ...baseInput, confidenceScore: -0.1 })).toThrow()
	})

	it('rejects valid_to earlier than valid_from', () => {
		expect(() =>
			signupResearchInputSchema.parse({
				...baseInput,
				validTo: '2026-01-14T00:00:00.000Z',
			}),
		).toThrow()
	})

	it('rejects an invalid staleness class', () => {
		expect(() =>
			signupResearchInputSchema.parse({ ...baseInput, stalenessClass: 'forever' }),
		).toThrow()
	})

	it('rejects an empty claim', () => {
		expect(() => signupResearchInputSchema.parse({ ...baseInput, claim: '   ' })).toThrow()
	})
})

describe('bucketConfidence + statusForConfidence', () => {
	it('buckets numeric scores into the existing enum', () => {
		expect(bucketConfidence(0.95)).toBe('high')
		expect(bucketConfidence(0.8)).toBe('high')
		expect(bucketConfidence(0.5)).toBe('medium')
		expect(bucketConfidence(0.79)).toBe('medium')
		expect(bucketConfidence(0.49)).toBe('low')
		expect(bucketConfidence(0)).toBe('low')
	})

	it('routes low-confidence facts to draft and high to validated', () => {
		expect(statusForConfidence(0.9)).toBe('validated')
		expect(statusForConfidence(CONFIDENCE_ROUTING_THRESHOLD)).toBe('validated')
		expect(statusForConfidence(CONFIDENCE_ROUTING_THRESHOLD - 0.01)).toBe('draft')
		expect(statusForConfidence(0.2)).toBe('draft')
	})
})

describe('buildSignupResearchKnowledge', () => {
	it('returns a payload that satisfies createObjectSchema', () => {
		const payload = buildSignupResearchKnowledge(baseInput)
		expect(() => createObjectSchema.parse(payload)).not.toThrow()
	})

	it('writes provenance, bi-temporal, and routing fields onto metadata', () => {
		const payload = buildSignupResearchKnowledge(baseInput)
		const meta = payload.metadata as Record<string, unknown>
		expect(meta.source).toBe(SIGNUP_RESEARCH_SOURCE)
		expect(meta.provenance_source).toBe(baseInput.source)
		expect(meta.claim).toBe(baseInput.claim)
		expect(meta.confidence_score).toBe(baseInput.confidenceScore)
		expect(meta.confidence).toBe('high')
		expect(meta.staleness_class).toBe(SHORT_STALENESS_CLASS)
		expect(meta.valid_from).toBe(baseInput.validFrom)
		expect(meta.valid_to).toBeNull()
		expect(typeof meta.ingested_at).toBe('string')
		expect(meta.supersedes).toBeNull()
		expect(meta.tags).toEqual(['context:company'])
	})

	it('writes status=validated when confidence is high enough to inform bets', () => {
		const payload = buildSignupResearchKnowledge({ ...baseInput, confidenceScore: 0.85 })
		expect(payload.status).toBe('validated')
	})

	it('writes status=draft when confidence is too low to silently inform a bet', () => {
		const payload = buildSignupResearchKnowledge({ ...baseInput, confidenceScore: 0.3 })
		expect(payload.status).toBe('draft')
		const meta = payload.metadata as Record<string, unknown>
		expect(meta.confidence).toBe('low')
	})

	it('long staleness for mission / industry stays writable too', () => {
		const payload = buildSignupResearchKnowledge({
			...baseInput,
			stalenessClass: LONG_STALENESS_CLASS,
			claim: 'Acme operates in industrial automation.',
		})
		const meta = payload.metadata as Record<string, unknown>
		expect(meta.staleness_class).toBe(LONG_STALENESS_CLASS)
	})
})

describe('buildInvalidationPatch + supersede chain', () => {
	it('produces a patch that satisfies updateObjectSchema', () => {
		const patch = buildInvalidationPatch({ validTo: '2026-06-23T12:00:00.000Z' })
		expect(() => updateObjectSchema.parse(patch)).not.toThrow()
	})

	it('marks the old row deprecated and sets valid_to without touching content', () => {
		const patch = buildInvalidationPatch({ validTo: '2026-06-23T12:00:00.000Z' })
		expect(patch.status).toBe('deprecated')
		expect(patch.metadata).toEqual({ valid_to: '2026-06-23T12:00:00.000Z' })
		expect((patch.metadata as Record<string, unknown>).claim).toBeUndefined()
		expect(patch.content).toBeUndefined()
	})

	it('round-trip: an "as-of" query before invalidation returns the old value, after returns the new one', () => {
		const headcount20 = buildSignupResearchKnowledge({
			...baseInput,
			claim: 'Acme headcount: 20 (2026-01).',
			validFrom: '2026-01-01T00:00:00.000Z',
		})
		const invalidationAt = '2026-03-01T00:00:00.000Z'
		const invalidated = {
			...headcount20,
			status: 'deprecated',
			metadata: {
				...(headcount20.metadata as Record<string, unknown>),
				valid_to: invalidationAt,
			},
		}
		const headcount45 = buildSignupResearchKnowledge({
			...baseInput,
			claim: 'Acme headcount: 45 (2026-03).',
			validFrom: invalidationAt,
			supersedes: '00000000-0000-4000-8000-000000000001',
		})

		expect(isValidAt(invalidated, '2026-02-15T00:00:00.000Z')).toBe(true)
		expect(isValidAt(headcount45, '2026-02-15T00:00:00.000Z')).toBe(false)

		expect(isValidAt(invalidated, '2026-03-15T00:00:00.000Z')).toBe(false)
		expect(isValidAt(headcount45, '2026-03-15T00:00:00.000Z')).toBe(true)
	})

	it('isValidAt: a never-invalidated row stays valid forever', () => {
		const row = buildSignupResearchKnowledge(baseInput)
		expect(isValidAt(row, '2030-01-01T00:00:00.000Z')).toBe(true)
	})

	it('isValidAt: a row whose valid_from is in the future is not yet valid', () => {
		const row = buildSignupResearchKnowledge({
			...baseInput,
			validFrom: '2027-01-01T00:00:00.000Z',
		})
		expect(isValidAt(row, '2026-06-23T00:00:00.000Z')).toBe(false)
	})

	it('isValidAt: missing valid_from → not valid', () => {
		expect(isValidAt({ metadata: {} }, '2026-06-23T00:00:00.000Z')).toBe(false)
	})
})
