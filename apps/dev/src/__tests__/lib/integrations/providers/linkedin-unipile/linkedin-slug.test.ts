import { describe, expect, it } from 'vitest'
import {
	sameLinkedinSlug,
	slugFromLinkedinUrl,
} from '../../../../../lib/integrations/providers/linkedin-unipile/linkedin-slug'

describe('slugFromLinkedinUrl', () => {
	it('reads the segment after /in/', () => {
		expect(slugFromLinkedinUrl('https://www.linkedin.com/in/martin-emil-sloth-55a6655')).toBe(
			'martin-emil-sloth-55a6655',
		)
	})

	it('lowercases, drops query, fragment and trailing slash', () => {
		expect(slugFromLinkedinUrl('https://linkedin.com/in/Martin/?utm_source=x#top')).toBe('martin')
	})

	it('url-decodes the segment', () => {
		expect(slugFromLinkedinUrl('https://linkedin.com/in/j%C3%B8rgen-s')).toBe('jørgen-s')
	})

	it('keeps the raw segment when the escape is malformed', () => {
		expect(slugFromLinkedinUrl('https://linkedin.com/in/bad%zz')).toBe('bad%zz')
	})

	it('ignores path parts after the slug', () => {
		expect(slugFromLinkedinUrl('https://linkedin.com/in/martin/details/experience/')).toBe('martin')
	})

	it('returns null when there is no /in/ slug', () => {
		expect(slugFromLinkedinUrl('https://linkedin.com/company/acme')).toBeNull()
		expect(slugFromLinkedinUrl('https://linkedin.com/in/')).toBeNull()
		expect(slugFromLinkedinUrl('')).toBeNull()
		expect(slugFromLinkedinUrl(null)).toBeNull()
		expect(slugFromLinkedinUrl(undefined)).toBeNull()
	})
})

describe('sameLinkedinSlug', () => {
	it('matches the same slug across URL variants', () => {
		expect(
			sameLinkedinSlug('https://www.linkedin.com/in/Martin/', 'http://linkedin.com/in/martin?x=1'),
		).toBe(true)
	})

	it('does NOT match martin against martin-emil-sloth-55a6655 (equality, never substring)', () => {
		expect(
			sameLinkedinSlug(
				'https://linkedin.com/in/martin',
				'https://linkedin.com/in/martin-emil-sloth-55a6655',
			),
		).toBe(false)
		expect(
			sameLinkedinSlug(
				'https://linkedin.com/in/martin-emil-sloth-55a6655',
				'https://linkedin.com/in/martin',
			),
		).toBe(false)
	})

	it('never matches when either side has no slug', () => {
		expect(sameLinkedinSlug(null, null)).toBe(false)
		expect(sameLinkedinSlug('https://linkedin.com/in/martin', null)).toBe(false)
		expect(sameLinkedinSlug('not a url', 'not a url')).toBe(false)
	})
})
