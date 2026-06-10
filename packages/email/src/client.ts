import { Resend } from 'resend'

const apiKey = process.env['RESEND_API_KEY']
if (!apiKey) {
	throw new Error('RESEND_API_KEY is required but not set')
}

export const resend = new Resend(apiKey)
