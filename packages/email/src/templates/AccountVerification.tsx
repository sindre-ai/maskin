import { Button, Heading, Link, Text } from '@react-email/components'
import { BaseLayout } from './BaseLayout'

export interface AccountVerificationProps {
	name: string
	verificationUrl: string
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

export function AccountVerification({ name, verificationUrl }: AccountVerificationProps) {
	return (
		<BaseLayout preview="Confirm your email to activate your Maskin account.">
			<Heading style={headingStyle}>Verify your email, {name}</Heading>
			<Text style={bodyTextStyle}>
				Thanks for signing up for Maskin. Confirm this email is yours so you can start spinning up
				agents and running the shop.
			</Text>
			<Text style={buttonWrapperStyle}>
				<Button href={verificationUrl} style={buttonStyle}>
					Verify email
				</Button>
			</Text>
			<Text style={fallbackStyle}>
				Or paste this link into your browser:{' '}
				<Link href={verificationUrl} style={fallbackLinkStyle}>
					{verificationUrl}
				</Link>
			</Text>
			<Text style={bodyTextStyle}>
				This link expires in 24 hours. If you didn't create a Maskin account, you can safely ignore
				this email.
			</Text>
		</BaseLayout>
	)
}
