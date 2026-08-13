import { render } from '@react-email/render'
import type { ReactElement } from 'react'
import { AccountVerification, type AccountVerificationProps } from './templates/AccountVerification'
import { BillingReceipt, type BillingReceiptProps } from './templates/BillingReceipt'
import { OutOfCreditsAlert, type OutOfCreditsAlertProps } from './templates/OutOfCreditsAlert'
import { PasswordReset, type PasswordResetProps } from './templates/PasswordReset'
import { TeamInvite, type TeamInviteProps } from './templates/TeamInvite'

export interface TemplateRegistry {
	'account-verification': AccountVerificationProps
	'password-reset': PasswordResetProps
	'team-invite': TeamInviteProps
	'billing-receipt': BillingReceiptProps
	'out-of-credits-alert': OutOfCreditsAlertProps
}

export type TemplateName = keyof TemplateRegistry

const templates: {
	[K in TemplateName]: (props: TemplateRegistry[K]) => ReactElement
} = {
	'account-verification': AccountVerification,
	'password-reset': PasswordReset,
	'team-invite': TeamInvite,
	'billing-receipt': BillingReceipt,
	'out-of-credits-alert': OutOfCreditsAlert,
}

export interface RenderedTemplate {
	html: string
	text: string
}

export async function renderTemplate<K extends TemplateName>(
	name: K,
	props: TemplateRegistry[K],
): Promise<RenderedTemplate> {
	const template = templates[name]
	const element = template(props)
	const [html, text] = await Promise.all([render(element), render(element, { plainText: true })])
	return { html, text }
}
