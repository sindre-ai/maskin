import { describeObjectProperties } from '@/lib/object-properties'
import { describe, expect, it } from 'vitest'

describe('describeObjectProperties', () => {
	it('names the channel first, then short values', () => {
		expect(
			describeObjectProperties({
				source: 'sales_conversation',
				priority: 'P1',
				channel: 'linkedin_dm',
				pending_draft: null,
			}),
		).toEqual(['LinkedIn message', 'P1'])
	})

	it('reads an unknown channel as its own words', () => {
		expect(describeObjectProperties({ channel: 'carrier_pigeon' })).toEqual(['Carrier pigeon'])
	})

	it('labels plain values and skips long text, lists, objects and internal keys', () => {
		expect(
			describeObjectProperties({
				account: 'Sebastian',
				notes: 'x'.repeat(200),
				tags: ['a'],
				nested: { a: 1 },
				_internal: 'hidden',
			}),
		).toEqual(['Account: Sebastian'])
	})

	it('leaves out what the preview already shows, and nothing else', () => {
		const metadata = {
			channel: 'linkedin_dm',
			priority: 'P1',
			recipient: ' liz benison ',
			account: 'Sebastian',
			email: 'LIZ@example.com',
		}
		expect(
			describeObjectProperties(metadata, {
				recipients: ['Liz Benison', null, 'liz@example.com'],
				label: 'LinkedIn message',
			}),
		).toEqual(['P1', 'Account: Sebastian'])
		// A label that reads differently from the channel keeps the channel line.
		expect(describeObjectProperties(metadata, { recipients: [], label: 'Message' })).toContain(
			'LinkedIn message',
		)
		// Without a preview nothing is dropped.
		expect(describeObjectProperties(metadata)).toEqual([
			'LinkedIn message',
			'P1',
			'Recipient: liz benison',
			'Account: Sebastian',
			'Email: LIZ@example.com',
		])
	})

	it('is empty for no metadata', () => {
		expect(describeObjectProperties(null)).toEqual([])
		expect(describeObjectProperties([])).toEqual([])
	})
})
