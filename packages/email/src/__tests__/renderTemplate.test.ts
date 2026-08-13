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

	describe('password-reset', () => {
		const props = {
			name: 'Sindre',
			resetUrl: 'https://maskin.io/reset?token=abc123',
			expiresInMinutes: 30,
		} as const

		it('returns html and text', async () => {
			const result = await renderTemplate('password-reset', props)
			expect(result.html.length).toBeGreaterThan(0)
			expect(result.text.length).toBeGreaterThan(0)
		})

		it('embeds the reset url, recipient name, and expiry window in html', async () => {
			const { html } = await renderTemplate('password-reset', props)
			expect(html.toLowerCase()).toContain('<!doctype html')
			expect(html).toContain(props.resetUrl)
			expect(html).toContain(props.name)
			expect(html).toContain('30 minutes')
		})

		it('embeds the reset url, recipient name, and expiry window in text without html tags', async () => {
			const { text } = await renderTemplate('password-reset', props)
			expect(text).toContain(props.resetUrl)
			expect(text.toLowerCase()).toContain('sindre')
			expect(text).toContain('30 minutes')
			expect(text).not.toMatch(/<[a-z][^>]*>/i)
		})

		it('escapes the recipient name to prevent html injection', async () => {
			const { html } = await renderTemplate('password-reset', {
				...props,
				name: '<script>alert(1)</script>',
			})
			expect(html).not.toContain('<script>alert(1)</script>')
			expect(html).toContain('&lt;script&gt;')
		})

		it('matches the html snapshot', async () => {
			const { html } = await renderTemplate('password-reset', props)
			expect(html).toMatchSnapshot()
		})

		it('matches the text snapshot', async () => {
			const { text } = await renderTemplate('password-reset', props)
			expect(text).toMatchSnapshot()
		})
	})

	describe('team-invite', () => {
		const props = {
			inviterName: 'Sindre',
			workspaceName: 'Acme Widgets',
			inviteUrl: 'https://maskin.io/invite?token=abc123',
		} as const

		it('returns html and text', async () => {
			const result = await renderTemplate('team-invite', props)
			expect(result.html.length).toBeGreaterThan(0)
			expect(result.text.length).toBeGreaterThan(0)
		})

		it('embeds the invite url, inviter, and workspace name in html', async () => {
			const { html } = await renderTemplate('team-invite', props)
			expect(html.toLowerCase()).toContain('<!doctype html')
			expect(html).toContain(props.inviteUrl)
			expect(html).toContain(props.inviterName)
			expect(html).toContain(props.workspaceName)
		})

		it('embeds the invite url and workspace name in text without html tags', async () => {
			const { text } = await renderTemplate('team-invite', props)
			expect(text).toContain(props.inviteUrl)
			expect(text).toContain(props.workspaceName)
			expect(text).not.toMatch(/<[a-z][^>]*>/i)
		})

		it('escapes the workspace name to prevent html injection', async () => {
			const { html } = await renderTemplate('team-invite', {
				...props,
				workspaceName: '<script>alert(1)</script>',
			})
			expect(html).not.toContain('<script>alert(1)</script>')
			expect(html).toContain('&lt;script&gt;')
		})

		it('matches the html snapshot', async () => {
			const { html } = await renderTemplate('team-invite', props)
			expect(html).toMatchSnapshot()
		})

		it('matches the text snapshot', async () => {
			const { text } = await renderTemplate('team-invite', props)
			expect(text).toMatchSnapshot()
		})
	})

	describe('billing-receipt', () => {
		const props = {
			amount: 49.0,
			currency: 'USD',
			periodStart: '2026-07-01',
			periodEnd: '2026-07-31',
			invoiceUrl: 'https://maskin.io/invoices/in_abc123',
		} as const

		it('returns html and text', async () => {
			const result = await renderTemplate('billing-receipt', props)
			expect(result.html.length).toBeGreaterThan(0)
			expect(result.text.length).toBeGreaterThan(0)
		})

		it('embeds the invoice url and a formatted currency amount in html', async () => {
			const { html } = await renderTemplate('billing-receipt', props)
			expect(html.toLowerCase()).toContain('<!doctype html')
			expect(html).toContain(props.invoiceUrl)
			expect(html).toContain('$49.00')
		})

		it('embeds the invoice url and formatted amount in text without html tags', async () => {
			const { text } = await renderTemplate('billing-receipt', props)
			expect(text).toContain(props.invoiceUrl)
			expect(text).toContain('$49.00')
			expect(text).not.toMatch(/<[a-z][^>]*>/i)
		})

		it('normalizes lowercase currency codes to uppercase', async () => {
			const { html } = await renderTemplate('billing-receipt', {
				...props,
				currency: 'eur',
			})
			expect(html).toContain('€49.00')
		})

		it('matches the html snapshot', async () => {
			const { html } = await renderTemplate('billing-receipt', props)
			expect(html).toMatchSnapshot()
		})

		it('matches the text snapshot', async () => {
			const { text } = await renderTemplate('billing-receipt', props)
			expect(text).toMatchSnapshot()
		})
	})

	describe('out-of-credits-alert', () => {
		const props = {
			workspaceName: 'Acme Widgets',
			creditsUsed: 10000,
			creditsTotal: 10000,
			upgradeUrl: 'https://maskin.io/billing/upgrade',
		} as const

		it('returns html and text', async () => {
			const result = await renderTemplate('out-of-credits-alert', props)
			expect(result.html.length).toBeGreaterThan(0)
			expect(result.text.length).toBeGreaterThan(0)
		})

		it('uses the loss-framed "your agents have paused" copy in html', async () => {
			const { html } = await renderTemplate('out-of-credits-alert', props)
			expect(html.toLowerCase()).toContain('<!doctype html')
			expect(html).toContain('Your agents have paused')
			expect(html).toContain(props.workspaceName)
			expect(html).toContain(props.upgradeUrl)
			expect(html).toContain('10,000')
		})

		it('uses the loss-framed copy in text without html tags', async () => {
			const { text } = await renderTemplate('out-of-credits-alert', props)
			expect(text.toLowerCase()).toContain('your agents have paused')
			expect(text).toContain(props.upgradeUrl)
			expect(text).toContain('10,000')
			expect(text).not.toMatch(/<[a-z][^>]*>/i)
		})

		it('escapes the workspace name to prevent html injection', async () => {
			const { html } = await renderTemplate('out-of-credits-alert', {
				...props,
				workspaceName: '<script>alert(1)</script>',
			})
			expect(html).not.toContain('<script>alert(1)</script>')
			expect(html).toContain('&lt;script&gt;')
		})

		it('matches the html snapshot', async () => {
			const { html } = await renderTemplate('out-of-credits-alert', props)
			expect(html).toMatchSnapshot()
		})

		it('matches the text snapshot', async () => {
			const { text } = await renderTemplate('out-of-credits-alert', props)
			expect(text).toMatchSnapshot()
		})
	})
})
