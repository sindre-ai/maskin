import { Button, Heading, Link, Text } from '@react-email/components'
import { BaseLayout } from './BaseLayout'

export interface OutOfCreditsAlertProps {
	workspaceName: string
	creditsUsed: number
	creditsTotal: number
	upgradeUrl: string
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

const alertTextStyle = {
	color: '#991b1b',
	fontSize: '15px',
	fontWeight: 500,
	lineHeight: '24px',
	margin: '0 0 16px',
}

const usageStyle = {
	color: '#6b7280',
	fontSize: '14px',
	lineHeight: '20px',
	margin: '0 0 24px',
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

export function OutOfCreditsAlert({
	workspaceName,
	creditsUsed,
	creditsTotal,
	upgradeUrl,
}: OutOfCreditsAlertProps) {
	return (
		<BaseLayout preview={`Your agents on ${workspaceName} have paused — out of credits.`}>
			<Heading style={headingStyle}>Your agents have paused</Heading>
			<Text style={alertTextStyle}>
				{workspaceName} is out of credits, so every agent in the workspace has stopped mid-run.
			</Text>
			<Text style={bodyTextStyle}>
				Bets in flight won't move forward until credits are back. Anything that was queued is
				waiting; anything scheduled will miss its run.
			</Text>
			<Text style={usageStyle}>
				{`Used ${creditsUsed.toLocaleString('en-US')} of ${creditsTotal.toLocaleString('en-US')} credits this cycle.`}
			</Text>
			<Text style={buttonWrapperStyle}>
				<Button href={upgradeUrl} style={buttonStyle}>
					Upgrade plan
				</Button>
			</Text>
			<Text style={fallbackStyle}>
				Or paste this link into your browser:{' '}
				<Link href={upgradeUrl} style={fallbackLinkStyle}>
					{upgradeUrl}
				</Link>
			</Text>
			<Text style={bodyTextStyle}>
				Agents resume automatically the moment credits are available again.
			</Text>
		</BaseLayout>
	)
}
