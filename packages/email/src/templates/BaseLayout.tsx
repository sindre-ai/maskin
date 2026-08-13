import {
	Body,
	Container,
	Head,
	Hr,
	Html,
	Img,
	Link,
	Preview,
	Section,
	Text,
} from '@react-email/components'
import type { ReactNode } from 'react'

export interface BaseLayoutProps {
	preview: string
	children: ReactNode
}

const bodyStyle = {
	backgroundColor: '#f6f7f8',
	fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
	margin: 0,
	padding: 0,
}

const containerStyle = {
	backgroundColor: '#ffffff',
	borderRadius: '8px',
	margin: '32px auto',
	maxWidth: '560px',
	padding: '32px',
}

const logoStyle = {
	display: 'block',
	margin: '0 auto 24px',
}

const hrStyle = {
	borderColor: '#e5e7eb',
	marginTop: '32px',
}

const footerStyle = {
	color: '#6b7280',
	fontSize: '12px',
	lineHeight: '18px',
	marginTop: '16px',
	textAlign: 'center' as const,
}

const footerLinkStyle = {
	color: '#6b7280',
	textDecoration: 'underline',
}

export function BaseLayout({ preview, children }: BaseLayoutProps) {
	return (
		<Html lang="en">
			<Head />
			<Preview>{preview}</Preview>
			<Body style={bodyStyle}>
				<Container style={containerStyle}>
					<Section>
						<Img
							src="https://maskin.io/email/maskin-logo.png"
							width={120}
							height={32}
							alt="Maskin"
							style={logoStyle}
						/>
					</Section>
					{children}
					<Hr style={hrStyle} />
					<Text style={footerStyle}>
						Sent by Maskin — the shop where AI does the work and humans set direction.
					</Text>
					<Text style={footerStyle}>
						You're getting this because you have a Maskin account.{' '}
						<Link href="https://maskin.io/settings/notifications" style={footerLinkStyle}>
							Manage email preferences
						</Link>
						.
					</Text>
				</Container>
			</Body>
		</Html>
	)
}
