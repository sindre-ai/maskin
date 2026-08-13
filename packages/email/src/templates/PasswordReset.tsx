import { Button, Heading, Link, Text } from '@react-email/components'
import { BaseLayout } from './BaseLayout'

export interface PasswordResetProps {
	name: string
	resetUrl: string
	expiresInMinutes: number
}

const headingStyle = {
	color: '#111827',
	fontSize: '22px',
	fontWeight: 600,
	lineHeight: '30px',
	margin: '0 0 16px',
}

const bodyTextStyle = {
	color: '#374151',
	fontSize: '15px',
	lineHeight: '24px',
	margin: '0 0 16px',
}

const buttonWrapperStyle = {
	margin: '24px 0',
	textAlign: 'left' as const,
}

const buttonStyle = {
	backgroundColor: '#111827',
	borderRadius: '6px',
	color: '#ffffff',
	display: 'inline-block',
	fontSize: '15px',
	fontWeight: 500,
	padding: '12px 20px',
	textDecoration: 'none',
}

const fallbackStyle = {
	color: '#6b7280',
	fontSize: '13px',
	lineHeight: '20px',
	margin: '0 0 24px',
	wordBreak: 'break-all' as const,
}

const fallbackLinkStyle = {
	color: '#4b5563',
	textDecoration: 'underline',
}

export function PasswordReset({ name, resetUrl, expiresInMinutes }: PasswordResetProps) {
	return (
		<BaseLayout preview="Reset your Maskin password.">
			<Heading style={headingStyle}>Reset your password, {name}</Heading>
			<Text style={bodyTextStyle}>
				We got a request to reset the password on your Maskin account. Set a new one so you can get
				back to running the shop.
			</Text>
			<Text style={buttonWrapperStyle}>
				<Button href={resetUrl} style={buttonStyle}>
					Reset password
				</Button>
			</Text>
			<Text style={fallbackStyle}>
				Or paste this link into your browser:{' '}
				<Link href={resetUrl} style={fallbackLinkStyle}>
					{resetUrl}
				</Link>
			</Text>
			<Text style={bodyTextStyle}>
				{`This link expires in ${expiresInMinutes} minutes. If you didn't ask to reset your password, you can safely ignore this email — your current password will keep working.`}
			</Text>
		</BaseLayout>
	)
}
