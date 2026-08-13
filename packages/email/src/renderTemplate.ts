import { render } from '@react-email/render'
import type { ReactElement } from 'react'
import { AccountVerification, type AccountVerificationProps } from './templates/AccountVerification'

export interface TemplateRegistry {
	'account-verification': AccountVerificationProps
}

export type TemplateName = keyof TemplateRegistry

const templates: {
	[K in TemplateName]: (props: TemplateRegistry[K]) => ReactElement
} = {
	'account-verification': AccountVerification,
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
