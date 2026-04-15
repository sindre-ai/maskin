import { describe, expect, it } from 'vitest'
import { parseToolData } from '../../mcp-apps/shared/mcp-app-provider'

describe('parseToolData', () => {
	it('returns structuredContent when present', () => {
		const result = parseToolData({
			structuredContent: { id: '1', name: 'Test' },
			content: [{ type: 'text', text: '{"id": "2", "name": "Wrong"}' }],
		})
		expect(result).toEqual({ id: '1', name: 'Test' })
	})

	it('prefers structuredContent over content', () => {
		const result = parseToolData({
			structuredContent: { source: 'structured' },
			content: [{ type: 'text', text: '{"source": "text"}' }],
		})
		expect(result).toEqual({ source: 'structured' })
	})

	it('returns structuredContent even if it is an empty object', () => {
		const result = parseToolData({ structuredContent: {} })
		expect(result).toEqual({})
	})

	it('falls back to parsing JSON from last text block', () => {
		const result = parseToolData({
			content: [
				{ type: 'text', text: 'Some formatted text that is not JSON' },
				{ type: 'text', text: '{"id": "1", "status": "ok"}' },
			],
		})
		expect(result).toEqual({ id: '1', status: 'ok' })
	})

	it('tries earlier text blocks if last one is not JSON', () => {
		const result = parseToolData({
			content: [
				{ type: 'text', text: '{"id": "1"}' },
				{ type: 'text', text: 'Not valid JSON' },
			],
		})
		expect(result).toEqual({ id: '1' })
	})

	it('returns null when no content blocks contain JSON', () => {
		const result = parseToolData({
			content: [
				{ type: 'text', text: 'Just plain text' },
				{ type: 'text', text: 'More plain text' },
			],
		})
		expect(result).toBeNull()
	})

	it('returns null for empty content array', () => {
		const result = parseToolData({ content: [] })
		expect(result).toBeNull()
	})

	it('returns null when content is undefined', () => {
		const result = parseToolData({})
		expect(result).toBeNull()
	})

	it('skips non-text content blocks', () => {
		const result = parseToolData({
			content: [
				{ type: 'image', text: '{"wrong": true}' },
				{ type: 'text', text: '{"correct": true}' },
			],
		})
		expect(result).toEqual({ correct: true })
	})

	it('skips text blocks without text field', () => {
		const result = parseToolData({
			content: [{ type: 'text' }, { type: 'text', text: '{"found": true}' }],
		})
		expect(result).toEqual({ found: true })
	})

	it('parses JSON arrays from text blocks', () => {
		const result = parseToolData({
			content: [{ type: 'text', text: '[1, 2, 3]' }],
		})
		expect(result).toEqual([1, 2, 3])
	})
})
