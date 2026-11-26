// Settings for the receipt email route, read from the apps/dev environment.
//
//   RECEIPT_INTAKE_DOMAIN          the domain Maskin owns and points at Resend receiving
//   RECEIPT_INTAKE_WEBHOOK_SECRET  the whsec_ secret of the one Resend webhook for that domain
//   RECEIPT_INTAKE_RESEND_API_KEY  a Resend key that can read received emails and attachments
//
// All three must be set for the email route to work. With any missing, the owner sees email as
// "not available yet", the webhook answers 503 and nothing is read. The command route needs none
// of them.

export type ReceiptIntakeConfig = {
	domain: string
	webhookSecret: string
	resendApiKey: string
}

export function readReceiptIntakeConfig(
	env: Record<string, string | undefined> = process.env,
): ReceiptIntakeConfig | null {
	const domain = env.RECEIPT_INTAKE_DOMAIN?.trim().toLowerCase()
	const webhookSecret = env.RECEIPT_INTAKE_WEBHOOK_SECRET?.trim()
	const resendApiKey = env.RECEIPT_INTAKE_RESEND_API_KEY?.trim()
	if (!domain || !webhookSecret || !resendApiKey) return null
	if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null
	return { domain, webhookSecret, resendApiKey }
}
