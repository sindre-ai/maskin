import { buildAwaitingViesReminderEmail } from '../../lib/vies-emails'

describe('buildAwaitingViesReminderEmail', () => {
	/**
	 * Pins the subject and body verbatim per bet spec Delta 2a Q2. Any
	 * change here must come with an approved copy change — the reminder
	 * copy is verbally negotiated with support/CX; do not "clean up" the
	 * whitespace or line breaks without a Sebk sign-off.
	 */
	it('returns the spec Delta 2a Q2 reminder copy verbatim', () => {
		const envelope = buildAwaitingViesReminderEmail({
			customerId: 'cus_x',
			sessionId: 'cs_y',
		})

		expect(envelope.subject).toBe('Still verifying your VAT number')
		expect(envelope.body).toBe(
			"We're still verifying your VAT number with the EU tax authority." +
				' No action needed — your credits will release automatically once verification' +
				' completes (usually within a few hours). If it takes longer than 24 hours from' +
				" purchase, we'll refund you and email you to retry.",
		)
		expect(envelope.customerId).toBe('cus_x')
		expect(envelope.sessionId).toBe('cs_y')
	})
})
