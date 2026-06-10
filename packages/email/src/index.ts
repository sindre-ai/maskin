import { createElement } from 'react'
import { resend } from './client.js'
import { PasswordResetEmail } from './templates/password-reset.js'

const fromAddress = process.env['EMAIL_FROM_ADDRESS'] ?? 'noreply@mail.maskin.app'

export async function sendPasswordReset(to: string, resetUrl: string): Promise<void> {
	const { data, error } = await resend.emails.send({
		from: fromAddress,
		to,
		subject: 'Reset your Maskin password',
		react: createElement(PasswordResetEmail, { resetUrl }),
	})

	if (error) {
		throw new Error(`Failed to send password reset email to ${to}: ${error.message}`)
	}

	console.info(`[email] password-reset sent id=${data?.id} to=${to}`)
}
