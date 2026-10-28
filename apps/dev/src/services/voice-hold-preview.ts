import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { events, objects } from '@maskin/db/schema'
import { MESSAGE_MAX_LENGTH, commentDecisionSchema } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { shownDraftHash, shownDraftText } from '../lib/integrations/providers/gmail/approval-hash'
import { splitSubject } from '../lib/integrations/providers/gmail/send'
import { buildObjectPreview } from '../lib/object-preview'
import { insertConversationMessage } from './conversation-messages'
import { type VoiceSessionRow, ensureVoiceConversation } from './voice-transcript'

/**
 * What a held call will do, built by the server from the real target and never by the model.
 *
 * A yes is only worth something if the person heard what they said yes to. Asking about "the task"
 * got a yes for text the person had not agreed to, so a hold carries the recipient, the subject and
 * the text as they read right now. The same text goes into the call's chat, and a fingerprint of it
 * is kept with the hold: when the model repeats the call, the fingerprint is worked out again from
 * the target, and a yes given for other text is thrown away (see voice-write-gate.ts).
 */

/**
 * Up to this many characters (recipient, subject and body together) the agent reads the whole
 * text aloud. Above it, the agent reads the recipient, the subject and the first and last few
 * sentences, says the full text is in the chat, and reads all of it if asked. Sebastian chose
 * this over a short cut because the part that matters can sit at the end of an email.
 */
export const VOICE_READ_ALOUD_MAX_CHARS = 1000
/** The most of a body handed to the model in a hold, so it can read it all when asked. */
export const VOICE_HOLD_BODY_MAX_CHARS = 4000
const EDGE_SENTENCES = 3
const EDGE_MAX_CHARS = 350

export interface HoldPreview {
	/** What will happen, in a few plain words. */
	summary: string
	/** Where it goes: "Name <address>" for an email, the chat or session for a message. */
	recipients: string[]
	subject: string | null
	/** The full text, not cut. */
	body: string | null
	/** A plain-words caveat: no text could be read, or the draft is not complete. */
	note: string | null
	/** Changes whenever what the call would do changes. Never given to the model. */
	fingerprint: string
}

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const isUuid = (value: unknown): value is string =>
	typeof value === 'string' &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

const asRecord = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {}

const text = (value: unknown): string | null =>
	typeof value === 'string' && value.trim() ? value : null

/** A preview whose fingerprint is a hash of what it shows. */
function fromText(parts: Omit<HoldPreview, 'fingerprint'>): HoldPreview {
	return {
		...parts,
		fingerprint: sha(['text', parts.summary, parts.recipients, parts.subject, parts.body]),
	}
}

function unavailable(summary: string, note: string): HoldPreview {
	return fromText({ summary, recipients: [], subject: null, body: null, note })
}

async function fromObject(
	db: Database,
	workspaceId: string,
	tool: string,
	objectId: string,
): Promise<HoldPreview | null> {
	const [object] = await db
		.select()
		.from(objects)
		.where(and(eq(objects.id, objectId), eq(objects.workspaceId, workspaceId)))
		.limit(1)
	if (!object) {
		return tool === 'gmail_send_email'
			? unavailable(
					'Send an email',
					'That email does not exist in this workspace, so there is nothing to read out and the send will be refused.',
				)
			: null
	}
	const preview = buildObjectPreview(object)
	if (!preview) {
		return tool === 'gmail_send_email'
			? fromText({
					summary: 'Send an email',
					recipients: [],
					subject: null,
					body: object.content ?? null,
					note: 'This is not filed as an email draft (no recipient or subject), so the send will be refused. Say so.',
				})
			: null
	}
	return {
		summary: tool === 'gmail_send_email' ? 'Send this email' : `${tool} on this ${preview.label}`,
		recipients: preview.recipients.flatMap((r) => {
			const who = r.name && r.address ? `${r.name} <${r.address}>` : (r.address ?? r.name)
			return who ? [r.role === 'cc' ? `cc ${who}` : who] : []
		}),
		subject: preview.subject,
		body: preview.body,
		note: preview.missing.length
			? `The draft is not complete. Missing: ${preview.missing.join(', ')}.`
			: null,
		fingerprint: preview.content_hash,
	}
}

/** The draft a decision card carries, as the card shows it now (gmail_send_email by approval_comment_id). */
async function fromCard(
	db: Database,
	workspaceId: string,
	cardId: number,
	draftId: string | null,
): Promise<HoldPreview> {
	const none = (note: string) => unavailable('Send an email', note)
	const [card] = await db
		.select({ data: events.data })
		.from(events)
		.where(
			and(
				eq(events.id, cardId),
				eq(events.workspaceId, workspaceId),
				eq(events.action, 'commented'),
			),
		)
		.limit(1)
	const decision = commentDecisionSchema.safeParse(
		(card?.data as { decision?: unknown } | null)?.decision,
	)
	if (!decision.success)
		return none('That card has no email draft to read out, so the send will be refused.')
	const stack = decision.data.drafts
	const draft = stack?.length ? stack.find((d) => d.id === draftId) : decision.data.draft
	if (!draft)
		return none('That card has no such email draft to read out, so the send will be refused.')

	const shown = await shownDraftText(db, workspaceId, draft)
	const parts = shown ? splitSubject(shown) : null
	if (!parts)
		return none('The draft on that card has no subject line and text, so the send will be refused.')
	const hash = await shownDraftHash(db, workspaceId, draft)
	return {
		summary: 'Send this email',
		recipients: draft.to ? [draft.to] : [],
		subject: parts.subject,
		body: parts.body,
		note: null,
		fingerprint: hash ?? sha(['card', draft.to ?? '', parts.subject, parts.body]),
	}
}

const MAX_ARG_CHARS = 80

function describeArg(value: unknown): string {
	const raw = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
	const flat = raw.replace(/\s+/g, ' ').trim()
	return flat.length > MAX_ARG_CHARS ? `${flat.slice(0, MAX_ARG_CHARS)}…` : flat
}

/** Tools whose arguments are the text itself: that text and where it goes. */
const TEXT_TOOLS: Record<
	string,
	{ summary: string; body: string; subject?: string; target?: [label: string, key: string] }
> = {
	post_conversation_message: {
		summary: 'Post a message in a chat',
		body: 'content',
		target: ['Chat', 'conversation_id'],
	},
	send_session_message: {
		summary: 'Send a message to a running agent session',
		body: 'content',
		target: ['Session', 'id'],
	},
	create_notification: {
		summary: 'Send a notification',
		subject: 'title',
		body: 'content',
		target: ['Person', 'target_actor_id'],
	},
	create_session: { summary: 'Start an agent session', body: 'action_prompt' },
}

function fromArguments(tool: string, args: Record<string, unknown>): HoldPreview {
	const known = TEXT_TOOLS[tool]
	if (known) {
		const target = known.target ? text(args[known.target[1]]) : null
		return fromText({
			summary: known.summary,
			recipients: target && known.target ? [`${known.target[0]} ${target}`] : [],
			subject: known.subject ? text(args[known.subject]) : null,
			body: text(args[known.body]),
			note: null,
		})
	}
	// Any other held tool: its name and the main things it was given, in a line each.
	const lines = Object.entries(args)
		.filter(([key, value]) => key !== 'workspace_id' && value !== undefined && value !== null)
		.slice(0, 6)
		.map(([key, value]) => `${key}: ${describeArg(value)}`)
	return fromText({
		summary: `Run ${tool}`,
		recipients: [],
		subject: null,
		body: lines.length ? lines.join('\n') : null,
		note: 'There is no text to read out for this one. Say plainly what it will do, from the details given.',
	})
}

export async function buildHoldPreview(input: {
	db: Database
	workspaceId: string
	tool: string
	args: unknown
}): Promise<HoldPreview> {
	const { db, workspaceId, tool } = input
	const args = asRecord(input.args)
	if (isUuid(args.object_id)) {
		const fromTarget = await fromObject(db, workspaceId, tool, args.object_id)
		if (fromTarget) return fromTarget
	}
	if (tool === 'gmail_send_email' && typeof args.approval_comment_id === 'number') {
		return fromCard(db, workspaceId, args.approval_comment_id, text(args.draft_id))
	}
	if (tool === 'gmail_send_email') {
		return unavailable(
			'Send an email',
			'No email was named, so there is nothing to read out and the send will be refused.',
		)
	}
	return fromArguments(tool, args)
}

function sentences(body: string): string[] {
	return body
		.split(/(?<=[.!?])\s+/)
		.map((s) => s.trim())
		.filter(Boolean)
}

function clip(value: string, max: number, fromEnd = false): string {
	if (value.length <= max) return value
	const cut = fromEnd ? value.slice(-max) : value.slice(0, max)
	const wordEdge = fromEnd ? cut.indexOf(' ') : cut.lastIndexOf(' ')
	const trimmed = wordEdge > 0 ? (fromEnd ? cut.slice(wordEdge + 1) : cut.slice(0, wordEdge)) : cut
	return fromEnd ? `…${trimmed}` : `${trimmed}…`
}

/** The first and the last few sentences of a long text, never overlapping. */
export function spokenEdges(body: string): { first: string; last: string } {
	const all = sentences(body)
	const head: string[] = []
	let used = 0
	for (const sentence of all.slice(0, EDGE_SENTENCES)) {
		if (head.length > 0 && used + sentence.length > EDGE_MAX_CHARS) break
		head.push(sentence)
		used += sentence.length
	}
	const rest = all.slice(head.length)
	const tail: string[] = []
	used = 0
	for (const sentence of rest.slice(-EDGE_SENTENCES).reverse()) {
		if (tail.length > 0 && used + sentence.length > EDGE_MAX_CHARS) break
		tail.unshift(sentence)
		used += sentence.length
	}
	return {
		first: clip(head.join(' '), EDGE_MAX_CHARS),
		last: tail.length ? clip(tail.join(' '), EDGE_MAX_CHARS, true) : '',
	}
}

/** The length the read-aloud rule counts: recipient, subject and body together. */
export function readAloudLength(preview: HoldPreview): number {
	return (
		preview.recipients.join(', ').length +
		(preview.subject?.length ?? 0) +
		(preview.body?.length ?? 0)
	)
}

/** What the model is told to say aloud for this hold. */
export function readAloudInstruction(preview: HoldPreview, inChat: boolean): string {
	if (!preview.body && !preview.subject && preview.recipients.length === 0) {
		return 'There is no text to read. Say in one plain sentence what it will do, then ask once.'
	}
	if (readAloudLength(preview) <= VOICE_READ_ALOUD_MAX_CHARS) {
		return 'Read aloud, in the language it is written in: the recipient, the subject and the whole text, word for word. Then ask once for a yes.'
	}
	if (!inChat) {
		return 'The text could not be put in the chat. Read aloud the recipient, the subject and the whole text, then ask once for a yes.'
	}
	const { first, last } = spokenEdges(preview.body ?? '')
	return `The text is long (${readAloudLength(preview)} characters). Read aloud: the recipient, the subject, then these opening sentences: "${first}"${last ? ` and these closing sentences: "${last}"` : ''}. Say the full text is in the chat. If the person asks, read all of it. Then ask once for a yes.`
}

/** The preview as the model sees it in the answer to a held call. */
export function formatHoldPreviewForModel(preview: HoldPreview): string {
	const body =
		preview.body && preview.body.length > VOICE_HOLD_BODY_MAX_CHARS
			? `${preview.body.slice(0, VOICE_HOLD_BODY_MAX_CHARS)}\n[The text is cut here. The rest is in the chat.]`
			: preview.body
	return [
		`What will happen: ${preview.summary}.`,
		preview.recipients.length ? `To: ${preview.recipients.join(', ')}` : '',
		preview.subject ? `Subject: ${preview.subject}` : '',
		body ? `Text:\n${body}` : '',
		preview.note ? `Note: ${preview.note}` : '',
	]
		.filter(Boolean)
		.join('\n')
}

/** The same text as a chat message: a block quote, so the person reads what will go out. */
export function formatHoldPreviewForChat(preview: HoldPreview): string {
	const quote = (value: string) =>
		value
			.split(/\r?\n/)
			.map((line) => `> ${line}`)
			.join('\n')
	const lines = [
		`**Waiting for your yes: ${preview.summary}**`,
		preview.recipients.length ? `To: ${preview.recipients.join(', ')}` : '',
		preview.subject ? `Subject: ${preview.subject}` : '',
		preview.body ? quote(preview.body) : '',
		preview.note ?? '',
	].filter(Boolean)
	const full = lines.join('\n\n')
	if (full.length <= MESSAGE_MAX_LENGTH) return full
	const marker = '\n\n[The text is cut here to fit the chat.]'
	return `${full.slice(0, MESSAGE_MAX_LENGTH - marker.length)}${marker}`
}

/** Puts the preview in the call's chat the way show_in_chat does. Returns the chat it landed in. */
export async function postHoldPreview(input: {
	db: Database
	session: Pick<VoiceSessionRow, 'id' | 'workspaceId' | 'humanActorId' | 'agentActorId'>
	agentName: string
	preview: HoldPreview
}): Promise<string> {
	const { db, session, preview } = input
	const conversationId = await ensureVoiceConversation(db, session, input.agentName)
	const message = await insertConversationMessage(db, {
		conversationId,
		workspaceId: session.workspaceId,
		actorId: session.agentActorId,
		content: formatHoldPreviewForChat(preview),
		metadata: { source: 'voice', voice_session_id: session.id },
		sessionId: null,
	})
	if (!message) throw new Error('hold preview message insert was suppressed')
	return conversationId
}
