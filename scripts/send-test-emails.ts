import { sendPasswordReset } from '../packages/email/src/index.js'

const RESET_URL = 'https://maskin.app/reset?token=prototype-test'

const recipientsRaw = process.env['TEST_EMAIL_RECIPIENTS']
if (!recipientsRaw) {
	console.error('Error: TEST_EMAIL_RECIPIENTS env var is required (comma-separated addresses)')
	process.exit(1)
}

const recipients = recipientsRaw
	.split(',')
	.map((r) => r.trim())
	.filter(Boolean)

if (recipients.length === 0) {
	console.error('Error: TEST_EMAIL_RECIPIENTS must contain at least one address')
	process.exit(1)
}

console.info(`Sending password-reset emails to ${recipients.length} recipient(s)...`)

for (const to of recipients) {
	try {
		await sendPasswordReset(to, RESET_URL)
	} catch (err) {
		console.error(`Send failed for ${to}:`, err)
		process.exit(1)
	}
}

console.info('Done.')
