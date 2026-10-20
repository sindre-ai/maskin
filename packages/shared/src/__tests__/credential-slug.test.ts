import { describe, expect, it } from 'vitest'
import { CREDENTIAL_SLUG_MAX_LENGTH, credentialSlug } from '../credential-slug'

describe('credentialSlug', () => {
	it.each([
		['Coolify', 'COOLIFY'],
		['Notion team', 'NOTION_TEAM'],
		['my key', 'MY_KEY'],
		['My-Key', 'MY_KEY'],
		['  --Cloudflare   API · Sindre AI--  ', 'CLOUDFLARE_API_SINDRE_AI'],
		['a1b2', 'A1B2'],
	])('%s -> %s', (name, slug) => {
		expect(credentialSlug(name)).toBe(slug)
	})

	it('gives the same slug for names that differ only by case and separators', () => {
		expect(credentialSlug('my key')).toBe(credentialSlug('My-Key'))
	})

	it('returns an empty string when nothing usable is left', () => {
		expect(credentialSlug('')).toBe('')
		expect(credentialSlug('🔑🔑')).toBe('')
		expect(credentialSlug('---')).toBe('')
	})

	it('drops non-ASCII letters rather than transliterating them', () => {
		expect(credentialSlug('Nøkkel ÆØÅ')).toBe('N_KKEL')
	})

	it(`caps at ${CREDENTIAL_SLUG_MAX_LENGTH} characters and never ends in an underscore`, () => {
		const long = credentialSlug(`${'a'.repeat(47)} b`)
		expect(long.length).toBeLessThanOrEqual(CREDENTIAL_SLUG_MAX_LENGTH)
		expect(long.endsWith('_')).toBe(false)
		expect(credentialSlug('x'.repeat(200))).toHaveLength(CREDENTIAL_SLUG_MAX_LENGTH)
	})
})
