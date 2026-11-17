import { describe, expect, it } from 'vitest'
import {
	bigNumber,
	button,
	clipAtWord,
	escapeHtml,
	nextStepLine,
	renderEmail,
	softBox,
	tickList,
	waitingRow,
} from '../../services/email-layout'

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

	it('is table-based with the logo, wordmark, a 600px card, a hidden preview and the stop link', () => {
		expect(html).toContain('<table role="presentation"')
		expect(html).toContain('src="https://maskin.io/apple-touch-icon.png"')
		expect(html).toContain('>Maskin</a>')
		expect(html).toContain('max-width: 600px')
		expect(html).toContain('Hidden &lt;preview&gt;')
		expect(html).toContain(`href="${escapeHtml('https://maskin.test/api/email/stop?token=a&b=c')}"`)
		expect(html).toContain('>Stop these emails</a>')
	})

	it("uses the web app's colours and font, not the maskin.io marketing palette", () => {
		for (const light of ['#f6f7f9', '#ffffff', '#e5e8ec', '#10131a', '#5a6372']) {
			expect(html).toContain(light)
		}
		expect(html).toContain("'Schibsted Grotesk'")
		expect(html).toContain('letter-spacing: -0.035em')
		expect(html).toContain('border-radius: 14px')
		expect(html).not.toMatch(
			/F0EDE7|FAFAF8|E2DDD7|141412|1C1B18|ECEAE4|A09A93|2A2925|2563EB|3B74F2/i,
		)
	})

	it('has a plain card with no blue top edge', () => {
		expect(html).not.toMatch(/height="3"/)
		expect(html).not.toMatch(/border-(top|left): 3px/)
	})

	it('draws the soft boxes, waiting number, ticks and button in the web app tokens', () => {
		const blocks = [
			bigNumber(2, 'things need you'),
			waitingRow('Starting with: x'),
			tickList(['one', 'two']),
			nextStepLine('Open it'),
			softBox('tip'),
			button('https://maskin.test/', 'Open it'),
		].join('')
		expect(blocks).toContain('color: #8f5508')
		expect(blocks).toContain(
			'background-color: #f6f7f9; border: 1px solid #e5e8ec; border-radius: 12px',
		)
		expect(blocks).toContain('background-color: #dff1e8; color: #166a49')
		expect(blocks.match(/border-top: 1px solid #eef0f4/g)).toHaveLength(1)
		expect(blocks).toContain('bgcolor="#2545c8"')
		expect(blocks).toContain('border-radius: 10px')
	})

	it('has no scripts and only the web font stylesheet as an external link', () => {
		expect(html).not.toMatch(/<script/i)
		expect(html.match(/<link[^>]*>/gi)).toEqual([
			expect.stringContaining('https://fonts.googleapis.com/css2?family=Schibsted+Grotesk'),
		])
	})

	it('carries dark-mode and phone-width rules', () => {
		expect(html).toContain('prefers-color-scheme: dark')
		for (const dark of [
			'#0d0f13',
			'#12151a',
			'#23272e',
			'#e8eaee',
			'#8a93a0',
			'#1a1d23',
			'#6a8cff',
			'#060b1f',
			'#e8b03e',
			'#4fd39a',
			'#022c22',
		]) {
			expect(html).toContain(dark)
		}
		expect(html).toContain('max-width: 620px')
		expect(html).toContain('<meta name="color-scheme" content="light dark">')
	})

	it('leaves the stop link out when there is no stopUrl', () => {
		const account = renderEmail({ preheader: 'x', blocks: ['<p>block</p>'] })
		expect(account).not.toContain('Stop these emails')
		expect(account).toContain('>maskin.io</a>')
	})
})
