export interface ResendEnv {
	apiKey: string
	from: string
}

export function readResendEnv(): ResendEnv {
	const apiKey = process.env.RESEND_API_KEY
	if (!apiKey) {
		throw new Error('RESEND_API_KEY environment variable is required')
	}
	const from = process.env.EMAIL_FROM
	if (!from) {
		throw new Error('EMAIL_FROM environment variable is required')
	}
	return { apiKey, from }
}
