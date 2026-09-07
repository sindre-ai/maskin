import { describe, expect, it } from 'vitest'
import {
	canonicalJson,
	computeContentHash,
} from '../../../../../lib/integrations/providers/linkedin-unipile/operations'

/**
 * The dedup ledger for the four destructive content/community tools keys off
 * `sha256(canonical-json(request-body))`. Two callers that render the same
 * JSON object with the fields in a different order must collide on the hash;
 * two callers with a meaningful difference (different text, different post,
 * different post_as page URN) must NOT collide. These tests pin the shape so
 * a future edit can't silently loosen dedup and let a real duplicate slip
 * through, or tighten it and stop deduping real retries.
 */
describe('canonicalJson', () => {
	it('sorts keys so field-order permutations collide', () => {
		const a = canonicalJson({ text: 'hi', post_as: 'urn:li:organization:1', foo: 1 })
		const b = canonicalJson({ foo: 1, text: 'hi', post_as: 'urn:li:organization:1' })
		expect(a).toBe(b)
	})

	it('preserves array order (so attachment order matters)', () => {
		const a = canonicalJson({ attachments: [{ id: 'a' }, { id: 'b' }] })
		const b = canonicalJson({ attachments: [{ id: 'b' }, { id: 'a' }] })
		expect(a).not.toBe(b)
	})

	it('recurses into nested objects', () => {
		const a = canonicalJson({ outer: { b: 2, a: 1 } })
		const b = canonicalJson({ outer: { a: 1, b: 2 } })
		expect(a).toBe(b)
	})

	it('skips undefined values (JSON has no undefined)', () => {
		const a = canonicalJson({ text: 'hi', post_as: undefined })
		const b = canonicalJson({ text: 'hi' })
		expect(a).toBe(b)
	})
})

describe('computeContentHash', () => {
	it('collides for semantically-identical requests', () => {
		const a = computeContentHash({ tool: 'linkedin_publish_post', text: 'hello', extras: {} })
		const b = computeContentHash({ extras: {}, text: 'hello', tool: 'linkedin_publish_post' })
		expect(a).toBe(b)
	})

	it('diverges when the text changes', () => {
		const a = computeContentHash({ tool: 'linkedin_publish_post', text: 'hello' })
		const b = computeContentHash({ tool: 'linkedin_publish_post', text: 'hello world' })
		expect(a).not.toBe(b)
	})

	it('diverges when the tool identity changes', () => {
		const a = computeContentHash({ tool: 'linkedin_publish_post', text: 'hello' })
		const b = computeContentHash({
			tool: 'linkedin_publish_business_page_post',
			text: 'hello',
			post_as: 'urn:li:organization:1',
		})
		expect(a).not.toBe(b)
	})

	it('diverges when the business-page URN changes', () => {
		const a = computeContentHash({
			tool: 'linkedin_publish_business_page_post',
			text: 'hi',
			post_as: 'urn:li:organization:1',
		})
		const b = computeContentHash({
			tool: 'linkedin_publish_business_page_post',
			text: 'hi',
			post_as: 'urn:li:organization:2',
		})
		expect(a).not.toBe(b)
	})

	it('produces a 64-char lowercase hex string (sha256)', () => {
		const h = computeContentHash({ x: 1 })
		expect(h).toMatch(/^[0-9a-f]{64}$/)
	})
})
