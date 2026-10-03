import { describe, expect, it } from 'vitest'
import {
	bucketNameFor,
	firstPersonWarning,
	toDocument,
} from '../../../lib/integrations/providers/telnyx/knowledge-exporter'

describe('knowledge exporter helpers', () => {
	it('renders a knowledge object as a markdown document named after its id', () => {
		expect(toDocument({ id: 'k1', title: 'Security', content: 'Data stays in the EU.' })).toEqual({
			name: 'k1.md',
			markdown: '# Security\n\nData stays in the EU.\n',
		})
		expect(toDocument({ id: 'k2', title: null, content: null })).toEqual({
			name: 'k2.md',
			markdown: '# Untitled\n',
		})
	})

	it('warns on first-person prose', () => {
		expect(firstPersonWarning('We built this last year.')).toBe(true)
		expect(firstPersonWarning('I think our pricing is fair.')).toBe(true)
		expect(firstPersonWarning('Maskin lets agents run day-to-day work.')).toBe(false)
	})

	it('does not warn on first-person words that sit inside code', () => {
		expect(firstPersonWarning('Use `we` as a variable.\n```\nconst us = 1\n```\nDone.')).toBe(false)
	})

	it('does not match words that merely contain the pronouns', () => {
		expect(firstPersonWarning('Focus on status, user and usage.')).toBe(false)
	})

	it('names one bucket per workspace', () => {
		expect(bucketNameFor('abc')).toBe('maskin-kb-abc')
	})
})
