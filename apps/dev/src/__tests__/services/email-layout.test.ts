import { describe, expect, it } from 'vitest'
import { clipAtWord, escapeHtml, renderEmail } from '../../services/email-layout'

describe('clipAtWord', () => {
	it('leaves text that fits alone and collapses its whitespace', () => {
		expect(clipAtWord('  one   two\nthree ', 20)).toBe('one two three')
	})

	it('cuts at a word boundary with an ellipsis, never mid-word', () => {
		const text = 'Approve the launch email and give the go-ahead to the whole team today'
		for (let max = 8; max < text.length; max++) {
			const out = clipAtWord(text, max)
			expect(out.length).toBeLessThanOrEqual(max)
			expect(out.endsWith('…')).toBe(true)
			expect(text.startsWith(`${out.slice(0, -1)} `)).toBe(true)
		}
	})

	it('keeps the last word when the cut lands exactly after it', () => {
		expect(clipAtWord('alpha beta gamma', 11)).toBe('alpha beta…')
	})

	it('drops trailing punctuation before the ellipsis', () => {
		expect(clipAtWord('Ship it, then rest', 9)).toBe('Ship it…')
	})

	it('cuts inside a single word only when that one word is longer than the limit', () => {
		expect(clipAtWord('x'.repeat(30), 10)).toBe(`${'x'.repeat(9)}…`)
	})
})

describe('renderEmail', () => {
	const html = renderEmail({
		preheader: 'Hidden <preview>',
		blocks: ['<p>block</p>'],
		stopUrl: 'https://maskin.test/api/email/stop?token=a&b=c',
	})

	it('is table-based with the brand strip, a 560px card, a hidden preview and the stop link', () => {
		expect(html).toContain('<table role="presentation"')
		expect(html).toContain('>Maskin</span>')
		expect(html).toContain('max-width: 560px')
		expect(html).toContain('Hidden &lt;preview&gt;')
		expect(html).toContain(`href="${escapeHtml('https://maskin.test/api/email/stop?token=a&b=c')}"`)
		expect(html).toContain('>Stop these emails</a>')
	})

	it('has no scripts, no images and no external stylesheets', () => {
		expect(html).not.toMatch(/<script|<img|<link/i)
	})

	it('carries dark-mode and phone-width rules', () => {
		expect(html).toContain('prefers-color-scheme: dark')
		expect(html).toContain('max-width: 480px')
		expect(html).toContain('<meta name="color-scheme" content="light dark">')
	})
})
