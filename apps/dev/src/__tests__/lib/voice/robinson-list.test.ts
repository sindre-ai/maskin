import { describe, expect, it } from 'vitest'
import {
	parseRobinsonCsv,
	robinsonListFromSet,
	sha256Hex,
} from '../../../lib/outreach/voice/robinson-list'

describe('parseRobinsonCsv', () => {
	it('reads plain numbers in any common Danish format', () => {
		const entries = parseRobinsonCsv('phone\n20123456\n"+45 30 12 34 56"\n0045-40123456\n')
		expect(entries).toEqual(new Set(['+4520123456', '+4530123456', '+4540123456']))
	})

	it('reads sha256 digests and lowercases them', () => {
		const digest = sha256Hex('+4520123456')
		expect(parseRobinsonCsv(`${digest.toUpperCase()}\n`)).toEqual(new Set([digest]))
	})

	it('ignores headers, blanks and non-Danish numbers', () => {
		expect(parseRobinsonCsv('number,note\n\n+46701234567,swedish\n')).toEqual(new Set())
	})
})

describe('robinsonListFromSet', () => {
	it('matches a plain entry and a hashed entry of the normalised number', () => {
		const list = robinsonListFromSet(new Set(['+4520123456', sha256Hex('+4530123456')]))
		expect(list.has('+4520123456')).toBe(true)
		expect(list.has('+4530123456')).toBe(true)
		expect(list.has('+4540123456')).toBe(false)
	})
})
