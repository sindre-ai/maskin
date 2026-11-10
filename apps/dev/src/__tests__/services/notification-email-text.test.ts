import { describe, expect, it } from 'vitest'
import { buildNotificationEmail } from '../../services/notification-email-text'

const base = {
	title: 'Approve the plan',
	body: 'The agent needs a yes before it can start.',
	buttonUrl: 'https://maskin.test/ws/objects/o1?surface=email&block=needs_you',
	buttonLabel: 'Open it',
	stopUrl: 'https://maskin.test/api/email/stop?token=t',
}

describe('notification email text', () => {
	it("uses the notification's own title and text, one button and the stop link", () => {
		const mail = buildNotificationEmail(base)
		expect(mail.subject).toBe('Approve the plan')
		expect(mail.text).toContain(base.body)
		expect(mail.text).toContain(`Open it: ${base.buttonUrl}`)
		expect(mail.text).toContain(`Stop these emails: ${base.stopUrl}`)
		expect(mail.html.match(/Open it/g)).toHaveLength(1)
		expect(mail.headers['List-Unsubscribe']).toBe(`<${base.stopUrl}>`)
		expect(mail.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
	})

	it('names the count for a rollup and leaves out the single notification text', () => {
		const mail = buildNotificationEmail({
			...base,
			rollupCount: 3,
			buttonLabel: 'See what needs you',
		})
		expect(mail.subject).toBe('3 things need you')
		expect(mail.text).not.toContain(base.body)
		expect(mail.text).toContain('See what needs you:')
	})

	it('clips a long text and escapes markup in the html', () => {
		const mail = buildNotificationEmail({ ...base, title: '<b>Hi</b>', body: 'x'.repeat(900) })
		expect(mail.html).toContain('&lt;b&gt;Hi&lt;/b&gt;')
		expect(mail.html).not.toContain('<b>Hi</b>')
		expect(mail.text).not.toContain('x'.repeat(500))
	})

	it('has no body paragraph when the notification has no text', () => {
		const mail = buildNotificationEmail({ ...base, body: null })
		expect(mail.text.split('\n').filter((l) => l.trim() !== '')).toHaveLength(3)
	})
})
