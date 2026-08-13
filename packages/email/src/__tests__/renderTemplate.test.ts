import { describe, expect, it } from 'vitest'
import { renderTemplate } from '..'

describe('renderTemplate', () => {
	it('returns html and text for account-verification', async () => {
		const result = await renderTemplate('account-verification', {
			name: 'Sindre',
			verificationUrl: 'https://maskin.io/verify?token=abc123',
		})
		expect(result).toEqual({
			html: expect.any(String),
			text: expect.any(String),
		})
		expect(result.html.length).toBeGreaterThan(0)
		expect(result.text.length).toBeGreaterThan(0)
	})

	it('produces valid HTML with a doctype and the verification url', async () => {
		const { html } = await renderTemplate('account-verification', {
			name: 'Sindre',
			verificationUrl: 'https://maskin.io/verify?token=abc123',
		})
		expect(html.toLowerCase()).toContain('<!doctype html')
		expect(html).toContain('https://maskin.io/verify?token=abc123')
		expect(html).toContain('Sindre')
	})

	it('produces a plain-text variant with the verification url and no html tags', async () => {
		const { text } = await renderTemplate('account-verification', {
			name: 'Sindre',
			verificationUrl: 'https://maskin.io/verify?token=abc123',
		})
		expect(text).toContain('https://maskin.io/verify?token=abc123')
		expect(text.toLowerCase()).toContain('sindre')
		expect(text).not.toMatch(/<[a-z][^>]*>/i)
	})

	it('escapes the recipient name to prevent HTML injection', async () => {
		const { html } = await renderTemplate('account-verification', {
			name: '<script>alert(1)</script>',
			verificationUrl: 'https://maskin.io/verify?token=abc',
		})
		expect(html).not.toContain('<script>alert(1)</script>')
		expect(html).toContain('&lt;script&gt;')
	})

	it('matches the html snapshot for account-verification', async () => {
		const { html } = await renderTemplate('account-verification', {
			name: 'Sindre',
			verificationUrl: 'https://maskin.io/verify?token=abc123',
		})
		expect(html).toMatchSnapshot()
	})

	it('matches the text snapshot for account-verification', async () => {
		const { text } = await renderTemplate('account-verification', {
			name: 'Sindre',
			verificationUrl: 'https://maskin.io/verify?token=abc123',
		})
		expect(text).toMatchSnapshot()
	})
})
