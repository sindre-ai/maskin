import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { MESSAGE_MAX_LENGTH, buildWebAppHref, resolveWebAppBaseUrl } from '@maskin/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { insertConversationMessage } from './conversation-messages'
import { type VoiceSessionRow, ensureVoiceConversation } from './voice-transcript'

/**
 * `show_in_chat`: the one tool only a Live call has. Voice is a poor way to read a draft or open a
 * link, so the agent puts the thing in the chat the call is pinned to and speaks a short summary.
 *
 * It is handled here, in-process, and never goes through the MCP server: it must only ever write
 * into this call's own conversation, which the model cannot be trusted to name. The message is an
 * ordinary markdown message, one link per paragraph, because both clients already draw such a
 * link as a card (a draft, a page) or a tappable link (anything else). It goes through
 * insertConversationMessage, not the POST /messages route, so it wakes no agent.
 */

export const VOICE_SHOW_IN_CHAT_TOOL = 'show_in_chat'
export const VOICE_SHOW_IN_CHAT_MAX_ITEMS = 5
const CAPTION_MAX_LENGTH = 200
const LABEL_MAX_LENGTH = 120
const URL_MAX_LENGTH = 2000
/** A shown link is at most this long once encoded, so five of them plus labels stay far under the chat limit. */
const HREF_MAX_LENGTH = 600

export const voiceShowInChatTool = {
	type: 'function' as const,
	name: VOICE_SHOW_IN_CHAT_TOOL,
	description: `Put things in front of the person in this call's chat so they can read or open them on screen: drafts, items from a list, a link they must open. Pass the ids of Maskin objects (task, bet, insight, draft) and/or web links, at most ${VOICE_SHOW_IN_CHAT_MAX_ITEMS} in all, and an optional one-line caption. Then say only a short summary out loud. Runs at once; it does not need a yes.`,
	parameters: {
		type: 'object',
		properties: {
			object_ids: {
				type: 'array',
				items: { type: 'string' },
				description: 'Ids of objects in this workspace to show.',
			},
			links: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						url: { type: 'string', description: 'An http or https address.' },
						label: { type: 'string', description: 'What the link is, in a few words.' },
					},
					required: ['url'],
				},
				description: 'Web links to show.',
			},
			caption: { type: 'string', description: 'One line to put above them.' },
		},
	},
}

const argsSchema = z.object({
	object_ids: z.array(z.string().uuid()).default([]),
	links: z
		.array(
			z.object({
				url: z.string().min(1).max(URL_MAX_LENGTH),
				label: z.string().max(500).optional(),
			}),
		)
		.default([]),
	caption: z.string().max(1000).optional(),
})

export class VoiceShowInChatError extends Error {}

const oneLine = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max)
// A label sits inside [..]; keep a stray bracket from ending it early.
const escapeLabel = (text: string) => text.replace(/[[\]\\]/g, '\\$&')
// The caption is the one piece of model text that sits outside a link, so it is made plain text:
// no link, image, html or emphasis syntax, and no address that a renderer would turn into a link.
const plainCaption = (text: string) =>
	text.replace(/(?:https?:\/\/|www\.)/gi, '').replace(/[[\]()<>!*_`~#|\\@]/g, '')

function cleanLink(rawUrl: string): string {
	let url: URL
	try {
		url = new URL(rawUrl.trim())
	} catch {
		throw new VoiceShowInChatError(`"${rawUrl.slice(0, 80)}" is not a web address.`)
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new VoiceShowInChatError('Only http and https links can be shown.')
	}
	if (url.username || url.password) {
		throw new VoiceShowInChatError('A link with a login in it cannot be shown.')
	}
	// Parentheses would end the markdown destination early.
	const href = url.href.replace(/\(/g, '%28').replace(/\)/g, '%29')
	if (href.length > HREF_MAX_LENGTH) {
		throw new VoiceShowInChatError(
			`A link longer than ${HREF_MAX_LENGTH} characters cannot be shown. Give a shorter address.`,
		)
	}
	return href
}

export interface ShowInChatInput {
	db: Database
	session: Pick<VoiceSessionRow, 'id' | 'workspaceId' | 'humanActorId' | 'agentActorId'>
	agentName: string
	args: unknown
	webAppBaseUrl?: string
}

export async function showInChat(
	input: ShowInChatInput,
): Promise<{ conversationId: string; messageId: number }> {
	const { db, session } = input
	const parsed = argsSchema.safeParse(input.args)
	if (!parsed.success) {
		throw new VoiceShowInChatError(
			'show_in_chat takes object_ids (uuids), links ({ url, label }) and an optional caption.',
		)
	}
	const objectIds = [...new Set(parsed.data.object_ids.map((id) => id.toLowerCase()))]
	const links = parsed.data.links
	const total = objectIds.length + links.length
	if (total === 0) throw new VoiceShowInChatError('Give at least one object id or link to show.')
	if (total > VOICE_SHOW_IN_CHAT_MAX_ITEMS) {
		throw new VoiceShowInChatError(
			`Show at most ${VOICE_SHOW_IN_CHAT_MAX_ITEMS} things at a time; split the rest into a later call.`,
		)
	}
	const checkedLinks = links.map((l) => ({ href: cleanLink(l.url), label: l.label }))

	// Never trust the model's ids: only objects of this call's workspace are shown.
	const rows = objectIds.length
		? await db
				.select({ id: objects.id, title: objects.title })
				.from(objects)
				.where(and(eq(objects.workspaceId, session.workspaceId), inArray(objects.id, objectIds)))
		: []
	const byId = new Map(rows.map((r) => [r.id, r.title]))
	const missing = objectIds.filter((id) => !byId.has(id))
	if (missing.length > 0) {
		throw new VoiceShowInChatError(
			`These are not objects in this workspace, so nothing was shown: ${missing.join(', ')}.`,
		)
	}

	const base = input.webAppBaseUrl ?? resolveWebAppBaseUrl(process.env)
	const paragraphs: string[] = []
	const caption = parsed.data.caption
		? plainCaption(oneLine(parsed.data.caption, CAPTION_MAX_LENGTH)).trim()
		: ''
	if (caption) paragraphs.push(caption)
	for (const id of objectIds) {
		const title = oneLine(byId.get(id) ?? '', LABEL_MAX_LENGTH) || 'Open'
		paragraphs.push(
			`[${escapeLabel(title)}](${buildWebAppHref(base, session.workspaceId, { kind: 'object', id })})`,
		)
	}
	for (const link of checkedLinks) {
		const label = oneLine(link.label ?? '', LABEL_MAX_LENGTH) || new URL(link.href).hostname
		paragraphs.push(`[${escapeLabel(label)}](${link.href})`)
	}

	const content = paragraphs.join('\n\n')
	// The caps above keep this far under the chat limit; this is the backstop, not a truncation.
	if (content.length > MESSAGE_MAX_LENGTH) {
		throw new VoiceShowInChatError('That is too much to show at once. Show fewer things.')
	}

	const conversationId = await ensureVoiceConversation(db, session, input.agentName)
	const message = await insertConversationMessage(db, {
		conversationId,
		workspaceId: session.workspaceId,
		actorId: session.agentActorId,
		content,
		metadata: { source: 'voice', voice_session_id: session.id },
		sessionId: null,
	})
	if (!message) throw new Error('show_in_chat message insert was suppressed')
	return { conversationId, messageId: message.id }
}
