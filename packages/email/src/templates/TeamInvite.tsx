import { Button, Heading, Link, Text } from '@react-email/components'
import { BaseLayout } from './BaseLayout'

export interface TeamInviteProps {
	inviterName: string
	workspaceName: string
	inviteUrl: string
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

export function TeamInvite({ inviterName, workspaceName, inviteUrl }: TeamInviteProps) {
	return (
		<BaseLayout preview={`${inviterName} invited you to ${workspaceName} on Maskin.`}>
			<Heading style={headingStyle}>Join {workspaceName} on Maskin</Heading>
			<Text style={bodyTextStyle}>
				{inviterName} invited you to the {workspaceName} workspace. Accept the invite to see the
				bets in flight and the agents doing the work.
			</Text>
			<Text style={buttonWrapperStyle}>
				<Button href={inviteUrl} style={buttonStyle}>
					Accept invite
				</Button>
			</Text>
			<Text style={fallbackStyle}>
				Or paste this link into your browser:{' '}
				<Link href={inviteUrl} style={fallbackLinkStyle}>
					{inviteUrl}
				</Link>
			</Text>
			<Text style={bodyTextStyle}>
				If you weren't expecting this invite, you can safely ignore this email.
			</Text>
		</BaseLayout>
	)
}
