import { sanitizeTitle } from '../../services/conversation-titler'

describe('sanitizeTitle', () => {
	it('returns a clean title unchanged', () => {
		expect(sanitizeTitle('Deploy pipeline failing')).toBe('Deploy pipeline failing')
	})

	it('trims and collapses whitespace', () => {
		expect(sanitizeTitle('  Deploy   pipeline\n failing  ')).toBe('Deploy pipeline failing')
	})

	it('strips wrapping straight and curly quotes', () => {
		expect(sanitizeTitle('"Deploy pipeline failing"')).toBe('Deploy pipeline failing')
		expect(sanitizeTitle('“Deploy pipeline failing”')).toBe('Deploy pipeline failing')
		expect(sanitizeTitle("'Deploy pipeline failing'")).toBe('Deploy pipeline failing')
	})

	it('strips a Title: preamble the model was told not to emit', () => {
		expect(sanitizeTitle('Title: Deploy pipeline failing')).toBe('Deploy pipeline failing')
	})

	it('strips trailing punctuation', () => {
		expect(sanitizeTitle('Deploy pipeline failing.')).toBe('Deploy pipeline failing')
	})

	it('truncates an over-long title with an ellipsis', () => {
		const result = sanitizeTitle('word '.repeat(40))
		expect(result).not.toBeNull()
		expect(result?.length).toBeLessThanOrEqual(60)
		expect(result?.endsWith('…')).toBe(true)
	})

	it('returns null for empty, whitespace-only, and non-string input', () => {
		expect(sanitizeTitle('')).toBeNull()
		expect(sanitizeTitle('   ')).toBeNull()
		expect(sanitizeTitle('""')).toBeNull()
		expect(sanitizeTitle(undefined)).toBeNull()
		expect(sanitizeTitle(42)).toBeNull()
	})
})
