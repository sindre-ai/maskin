import { Button, Heading, Link, Text } from '@react-email/components'
import { BaseLayout } from './BaseLayout'

export interface BillingReceiptProps {
	amount: number
	currency: string
	periodStart: string
	periodEnd: string
	invoiceUrl: string
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

const amountStyle = {
	color: '#111827',
	fontSize: '28px',
	fontWeight: 600,
	lineHeight: '36px',
	margin: '0 0 8px',
}

const periodStyle = {
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

function formatAmount(amount: number, currency: string): string {
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: currency.toUpperCase(),
	}).format(amount)
}

function formatDate(iso: string): string {
	const d = new Date(iso)
	if (Number.isNaN(d.getTime())) return iso
	return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export function BillingReceipt({
	amount,
	currency,
	periodStart,
	periodEnd,
	invoiceUrl,
}: BillingReceiptProps) {
	const formattedAmount = formatAmount(amount, currency)
	const period = `${formatDate(periodStart)} — ${formatDate(periodEnd)}`
	return (
		<BaseLayout preview={`Receipt for ${formattedAmount} — thanks for using Maskin.`}>
			<Heading style={headingStyle}>Payment received</Heading>
			<Text style={bodyTextStyle}>
				Thanks for using Maskin. Here's a receipt for your last billing cycle.
			</Text>
			<Text style={amountStyle}>{formattedAmount}</Text>
			<Text style={periodStyle}>{`Billing period: ${period}`}</Text>
			<Text style={buttonWrapperStyle}>
				<Button href={invoiceUrl} style={buttonStyle}>
					View invoice
				</Button>
			</Text>
			<Text style={fallbackStyle}>
				Or paste this link into your browser:{' '}
				<Link href={invoiceUrl} style={fallbackLinkStyle}>
					{invoiceUrl}
				</Link>
			</Text>
			<Text style={bodyTextStyle}>
				Need a change to your plan or billing details? Reply to this email and we'll sort it out.
			</Text>
		</BaseLayout>
	)
}
