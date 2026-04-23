import type { SindreEvent, UserAttachmentView } from '@/lib/sindre-stream'

export interface SindreExportContext {
	workspaceId: string
	frontendUrl: string
	userName: string
	agentName: string
}

/**
 * Serialises the Sindre transcript to a markdown document suitable for copy /
 * download. User turns are rendered under the current user's name with any
 * attached objects linked back to the workspace; assistant turns concatenate
 * consecutive text blocks under the agent's name. Non-text assistant events
 * (tool_use, thinking, result, system, debug) are intentionally omitted —
 * they're UI affordances, not something the reader of the export cares about.
 */
export function formatSindreMarkdown(events: SindreEvent[], ctx: SindreExportContext): string {
	const lines: string[] = [`# Conversation with ${ctx.agentName} in Maskin`, '']
	let lastRole: 'user' | 'assistant' | null = null

	for (const event of events) {
		if (event.kind === 'user') {
			if (lastRole !== null) lines.push('')
			lines.push(`## ${ctx.userName}`, '')
			if (event.attachments && event.attachments.length > 0) {
				for (const attachment of event.attachments) {
					lines.push(renderAttachment(attachment, ctx))
				}
				lines.push('')
			}
			lines.push(event.text)
			lastRole = 'user'
		} else if (event.kind === 'text') {
			if (lastRole !== 'assistant') {
				if (lastRole !== null) lines.push('')
				lines.push(`## ${ctx.agentName}`, '')
				lines.push(event.text)
			} else {
				lines.push('', event.text)
			}
			lastRole = 'assistant'
		}
	}

	return `${lines.join('\n').trimEnd()}\n`
}

function renderAttachment(attachment: UserAttachmentView, ctx: SindreExportContext): string {
	if (attachment.kind === 'object') {
		const title = attachment.title?.trim() || 'Untitled'
		const url = `${ctx.frontendUrl}/${ctx.workspaceId}/objects/${attachment.id}`
		return `[${title}](${url})`
	}
	if (attachment.kind === 'notification') {
		const title = attachment.title?.trim() || 'Notification'
		return `Notification: ${title}`
	}
	if (attachment.kind === 'file') {
		return `File: ${attachment.name}`
	}
	const name = attachment.name?.trim() || 'Agent'
	return `Agent: ${name}`
}

export function downloadSindreMarkdown(markdown: string, filename: string): void {
	const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
	const url = URL.createObjectURL(blob)
	const a = document.createElement('a')
	a.href = url
	a.download = filename
	document.body.appendChild(a)
	a.click()
	a.remove()
	URL.revokeObjectURL(url)
}

export function buildSindreExportFilename(agentName: string, date: Date = new Date()): string {
	const slug =
		agentName
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'conversation'
	const stamp = date.toISOString().slice(0, 10)
	return `${slug}-${stamp}.md`
}
