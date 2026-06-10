import {
	Body,
	Button,
	Container,
	Head,
	Heading,
	Html,
	Section,
	Text,
} from '@react-email/components'

interface PasswordResetEmailProps {
	resetUrl: string
}

export function PasswordResetEmail({ resetUrl }: PasswordResetEmailProps) {
	return (
		<Html>
			<Head />
			<Body style={{ backgroundColor: '#f9fafb', fontFamily: 'sans-serif' }}>
				<Container style={{ maxWidth: '560px', margin: '0 auto', padding: '40px 20px' }}>
					<Heading style={{ fontSize: '24px', color: '#111827', marginBottom: '16px' }}>
						Reset your password
					</Heading>
					<Text style={{ color: '#374151', marginBottom: '24px' }}>
						Click the button below to reset your Maskin password. This link expires in 1 hour.
					</Text>
					<Section>
						<Button
							href={resetUrl}
							style={{
								backgroundColor: '#111827',
								color: '#ffffff',
								padding: '12px 24px',
								borderRadius: '6px',
								textDecoration: 'none',
								display: 'inline-block',
							}}
						>
							Reset password
						</Button>
					</Section>
					<Text style={{ color: '#9ca3af', fontSize: '14px', marginTop: '32px' }}>
						If you didn&apos;t request this, you can safely ignore this email.
					</Text>
				</Container>
			</Body>
		</Html>
	)
}
