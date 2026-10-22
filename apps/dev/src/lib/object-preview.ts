import { createHash } from 'node:crypto'
import {
	type ObjectPreview,
	PREVIEW_KIND_KEY,
	type PreviewDetail,
	type PreviewRecipient,
} from '@maskin/shared'
import { listProviders } from './integrations/registry'
import type { DeliverableBodyBlock, DeliverableField, DeliverableKind } from './integrations/types'

/**
 * The `preview` of an object, computed from its current text and `metadata.kind`.
 *
 * The kinds come from the providers' `deliverables` declarations, so a provider that
 * declares one gets previews everywhere with no change here. An object whose kind no
 * provider declares (or without one) has no preview, and reads exactly as before.
 *
 * Reading never fails on bad data: a draft with a malformed address still previews,
 * with a warning, because the person looking at it is the one who fixes it.
 */

interface RegisteredKind {
	provider: string
	deliverable: DeliverableKind
}

let kindIndex: Map<string, RegisteredKind> | null = null

function kinds(): Map<string, RegisteredKind> {
	if (kindIndex) return kindIndex
	const index = new Map<string, RegisteredKind>()
	for (const { config } of listProviders()) {
		for (const deliverable of config.deliverables ?? []) {
			// First declaration wins; the contract test asserts kinds are unique.
			if (!index.has(deliverable.kind))
				index.set(deliverable.kind, { provider: config.name, deliverable })
		}
	}
	kindIndex = index
	return index
}

/** Every declared kind, for tests and for agent-facing docs. */
export function listDeliverableKinds(): RegisteredKind[] {
	return [...kinds().values()]
}

/** The declaration behind `metadata.kind`, or null when nothing delivers that kind. */
export function getDeliverableKind(kind: unknown): RegisteredKind | null {
	return typeof kind === 'string' ? (kinds().get(kind) ?? null) : null
}

/**
 * The kind an object is of: its `metadata.kind` when a provider declares it, otherwise the
 * kind whose `alsoMatches` pairs all hold in its metadata (a LinkedIn post filed with
 * `content_type: linkedin_post`, a sales task with `channel: linkedin_dm`). An explicit kind always wins.
 */
function kindOf(metadata: Record<string, unknown>): RegisteredKind | null {
	const declared = getDeliverableKind(metadata[PREVIEW_KIND_KEY])
	if (declared) return declared
	for (const registered of kinds().values()) {
		const pairs = registered.deliverable.alsoMatches
		if (pairs?.length && pairs.every((p) => metadata[p.key] === p.value)) return registered
	}
	return null
}

/**
 * The message inside content that carries more than the message: the lines between the
 * block's start marker and its end marker (or the end of the content). Content without the
 * start marker is the message as it stands, so an object written without the header still
 * previews.
 */
function readBodyBlock(content: string, block: DeliverableBodyBlock): string {
	const lines = content.split(/\r?\n/)
	const from = lines.findIndex((line) => line.trim() === block.start)
	if (from === -1) return content
	const rest = lines.slice(from + 1)
	const to = block.end ? rest.findIndex((line) => line.trim() === block.end) : -1
	return (to === -1 ? rest : rest.slice(0, to)).join('\n').trim()
}

// Older drafts keep the subject as the first line of the text ("Subject: Hello"),
// because a decision card had no subject field. Read it from there when the
// metadata has none, so nothing already written needs rewriting.
const SUBJECT_LINE = /^subject:[ \t]*(\S.*?)[ \t]*(?:\r?\n|$)/i

function stringField(metadata: Record<string, unknown>, key: string): string {
	const value = metadata[key]
	return typeof value === 'string' ? value.trim() : ''
}

function parseRecipients(raw: string, role: PreviewRecipient['role']): PreviewRecipient[] {
	return raw
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			const angle = part.match(/^(.*)<([^<>]+)>$/)
			if (!angle) return { role, name: null, address: part }
			const name = (angle[1] ?? '').trim().replace(/^"|"$/g, '').trim()
			return { role, name: name || null, address: (angle[2] ?? '').trim() }
		})
}

function looksLikeAddress(value: string): boolean {
	return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)
}

function isRecipientsField(field: DeliverableField) {
	return field.type === 'recipients'
}

export function buildObjectPreview(object: {
	content: string | null
	metadata: unknown
}): ObjectPreview | null {
	const metadata =
		object.metadata && typeof object.metadata === 'object' && !Array.isArray(object.metadata)
			? (object.metadata as Record<string, unknown>)
			: null
	if (!metadata) return null
	const registered = kindOf(metadata)
	if (!registered) return null
	const { provider, deliverable } = registered

	let body = object.content ?? ''
	if (deliverable.bodyBlock) body = readBodyBlock(body, deliverable.bodyBlock)
	const recipients: PreviewRecipient[] = []
	const details: PreviewDetail[] = []
	let subject: string | null = null
	let context: string | null = null
	const missing: string[] = []
	const warnings: string[] = []

	for (const field of deliverable.fields) {
		let value = stringField(metadata, field.key)
		if (!value && field.slot === 'subject') {
			const legacy = SUBJECT_LINE.exec(body.trimStart())
			if (legacy?.[1]) {
				value = legacy[1]
				body = body
					.trimStart()
					.slice(legacy[0].length)
					.replace(/^\r?\n/, '')
			}
		}
		if (!value) {
			if (field.required) missing.push(field.label)
			else if (field.recommended) warnings.push(`${field.label} is not filed.`)
			continue
		}
		if (field.maxLength && value.length > field.maxLength) {
			warnings.push(`${field.label} is longer than ${field.maxLength} characters.`)
		}
		if (isRecipientsField(field)) {
			const parsed = parseRecipients(value, field.role ?? 'to')
			for (const r of parsed) {
				if (field.address === 'email' && r.address && !looksLikeAddress(r.address)) {
					warnings.push(`"${r.address}" does not look like an email address.`)
				}
			}
			recipients.push(...parsed)
		} else if (field.slot === 'subject') {
			subject = value
		} else if (field.slot === 'context') {
			context = value
		} else if (field.slot !== 'hidden') {
			details.push({ label: field.label, value })
		}
	}

	if (!body.trim()) missing.push('Message')
	const maxLength = deliverable.bodyMaxLength ?? null
	if (maxLength && body.length > maxLength) {
		warnings.push(`The text is ${body.length - maxLength} characters over the ${maxLength} limit.`)
	}

	return {
		kind: deliverable.kind,
		label: deliverable.label,
		provider,
		recipients,
		subject,
		details,
		context,
		body,
		maxLength,
		missing,
		warnings,
		content_hash: previewContentHash({
			kind: deliverable.kind,
			recipients,
			subject,
			details,
			body,
		}),
	}
}

/**
 * What an approval is bound to: who it goes to, the subject, where it is published (the
 * detail lines) and the text. Anything else on the object (status, driver, a comment) can
 * change without changing what would be sent. A kind with no detail lines hashes exactly as
 * it did before they existed, so approvals already given stay valid.
 */
export function previewContentHash(parts: {
	kind: string
	recipients: PreviewRecipient[]
	subject: string | null
	details?: PreviewDetail[]
	body: string
}): string {
	const who = parts.recipients
		.map((r) => `${r.role}:${(r.address ?? r.name ?? '').toLowerCase()}`)
		.sort()
	const hashed: unknown[] = [parts.kind, who, parts.subject ?? '', parts.body]
	if (parts.details?.length) hashed.push(parts.details.map((d) => [d.label, d.value]))
	return createHash('sha256').update(JSON.stringify(hashed)).digest('hex')
}
