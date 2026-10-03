import { createHash } from 'node:crypto'
import { logger } from '../../../logger'
import type { AssistantPayload, TelnyxClient } from './client'

/**
 * The Telnyx Voice AI assistant, built from code so a prompt or tool change is one reviewed
 * diff and one idempotent REST call (tech spec section 2b.2, 2b.6, 7a). The payload shape
 * (tools, conversation_flow, tool_ids) follows the spec and has NOT been checked against
 * live Telnyx; the staging smoke is where that gets verified.
 */

export const ASSISTANT_MODEL = 'anthropic/claude-haiku-4-5'

// ---- Disclosure (section 7a) -------------------------------------------------
// Template wording needs product and positioning sign-off before go-live. The Speak node
// plays the rendered text verbatim, with no model turn.
export const DISCLOSURE_EN =
	'Hi {{prospect_first_name}}, this is an AI assistant calling on behalf of Maskin, do you have a moment?'
export const DISCLOSURE_DA =
	'Hej {{prospect_first_name}}, det her er en AI-assistent, der ringer på vegne af Maskin, har du et øjeblik?'

export type DisclosureLanguage = 'en' | 'da'

/** The text the Speak node plays. The dialer passes it as the disclosure_text dynamic variable. */
export function renderDisclosure(language: DisclosureLanguage, prospectFirstName: string): string {
	const template = language === 'da' ? DISCLOSURE_DA : DISCLOSURE_EN
	return template.replace('{{prospect_first_name}}', prospectFirstName.trim())
}

// ---- Confirmation turn (errata section 6) ------------------------------------
// Shipped as written by the Architect. The Danish draft needs a native read before go-live.
export const CONFIRM_EMAIL_EN =
	'Just to confirm, one email from Maskin to [address], and you can opt out any time. Okay?'
export const CONFIRM_EMAIL_DA =
	'Bare for at bekraefte: en e-mail fra Maskin til [adresse], og du kan til enhver tid framelde dig. Er det i orden?'

// ---- Tools -------------------------------------------------------------------

export interface DeclaredTool {
	name: string
	description: string
	/** JSON Schema for the tool's input; the Zod schema in tools.ts is the validator. */
	parameters: {
		type: 'object'
		properties: Record<string, unknown>
		required: string[]
	}
}

const str = (description: string, extra: Record<string, unknown> = {}) => ({
	type: 'string',
	description,
	...extra,
})

/** Five declared tools. send_followup_sms is deliberately absent (CTO ruling, patch 4). */
export const DECLARED_TOOLS: readonly DeclaredTool[] = [
	{
		name: 'book_meeting_slot',
		description:
			'Look up three free 30-minute meeting slots with Sebastian. Call after the prospect agrees to a meeting. Read the options out, then call confirm_meeting_slot with the one they pick.',
		parameters: {
			type: 'object',
			properties: {
				prospect_email: str('The prospect email address, as they gave it.'),
				prospect_name: str('The prospect full name.'),
				preferred_window: str('Optional: when they said they prefer, in their words.'),
			},
			required: ['prospect_email', 'prospect_name'],
		},
	},
	{
		name: 'confirm_meeting_slot',
		description:
			'Book one of the slots from book_meeting_slot. slot_index is the option number you read out, 1 to 3. Call only after the prospect picked a slot.',
		parameters: {
			type: 'object',
			properties: {
				slot_index: {
					type: 'integer',
					minimum: 1,
					maximum: 3,
					description: 'Option number, 1 to 3.',
				},
				prospect_email: str('The prospect email address.'),
				prospect_name: str('The prospect full name.'),
			},
			required: ['slot_index', 'prospect_email', 'prospect_name'],
		},
	},
	{
		name: 'flag_interest',
		description:
			'Record how interested the prospect is: hot (wants to talk to a person now) or warm (open to a meeting). A hot flag tries to transfer the call to Sebastian. Give a short reason.',
		parameters: {
			type: 'object',
			properties: {
				strength: { type: 'string', enum: ['warm', 'hot'], description: 'warm or hot.' },
				reason: str('One short sentence on why.'),
			},
			required: ['strength', 'reason'],
		},
	},
	{
		name: 'end_call_polite',
		description:
			'End the call politely. Call when the conversation is over: after a booking, a decline, or a goodbye. Give the reason in a few words.',
		parameters: {
			type: 'object',
			properties: { reason: str('Why the call is ending.') },
			required: ['reason'],
		},
	},
	{
		name: 'request_followup_email',
		description:
			'Call only after the prospect raised email themselves, you confirmed the address and told them they can opt out any time, and they said yes. Pass their words. Never call it to offer or to be helpful.',
		parameters: {
			type: 'object',
			properties: {
				prospect_quote: str(
					'The prospect own words answering your confirmation, not a paraphrase.',
					{
						maxLength: 280,
					},
				),
				agent_line: str('Your own last line before their yes, word for word.', { maxLength: 500 }),
			},
			required: ['prospect_quote'],
		},
	},
]

// ---- System prompt (section 2b.6 layer 1) ---------------------------------------
// Persona, guardrails and sequencing. The pitch and FAQ content belongs to the Sales Rep
// (Voice) follow-on task; the pitch below is deliberately minimal.
export const SYSTEM_PROMPT = `You are an AI assistant making a short outbound call on behalf of Maskin, a company whose product lets AI agents run day-to-day work while people set the direction. You are not a human and you never speak as one. The call has already opened with a fixed disclosure that you are an AI assistant; do not repeat it and do not contradict it.

The prospect is {{prospect_first_name}}. The email address on file for them is {{contact_email}}.

Tone: warm, brief, plain. Speak in the prospect's language (Danish or English). One idea per turn.

Goal: find out whether a short conversation with Sebastian, one of the founders, is worth their time, and book it if so.

Guardrails, always:
- Never state or hint at a price, discount or ROI number. Say Sebastian will cover that.
- Never name customers, revenue figures or funding.
- Never promise a timeline for an integration or a feature.
- If you are unsure of a fact, say: "Good question, Sebastian will walk you through that on the meeting. Want me to book a slot?"
- Never claim to be a person. Never say "I've been building this" or "we launched".
- Never offer to send an email, a text or anything else after the call.

Available actions (five tools):
- book_meeting_slot, then confirm_meeting_slot: call book_meeting_slot when the prospect agrees to a meeting, read the three options aloud as option 1, 2 and 3, then call confirm_meeting_slot with the one they choose.
- flag_interest: call with strength hot when the prospect wants to talk to a person right now, or warm when they are open to a meeting. After a hot flag the call may be transferred to Sebastian; if it is not, offer to book a slot instead.
- end_call_polite: call when the conversation is over. On a warm or hot signal you must have called book_meeting_slot and confirm_meeting_slot before this.
- request_followup_email: see the email sequence below. Nothing else triggers it.

Email sequence. You never offer an email. Only when the prospect raises email themselves ("send me something", "can you email me") do you do this, in order:
1. If you have no address on file, do not run the sequence and do not call the tool. Say someone will follow up.
2. Say one short, neutral line with no pitch. English: "${CONFIRM_EMAIL_EN}" Danish: "${CONFIRM_EMAIL_DA}" Put the address on file where [address] or [adresse] stands.
3. Wait for their answer. Do nothing else until they answer.
4. Only if the answer is a clear yes, call request_followup_email with their words as prospect_quote and your confirmation line as agent_line.
5. If they give a different address, or answer anything other than a yes, do not call the tool. Say someone will follow up.
Raising email alone is not a yes. Never call the tool before you have spoken the confirmation line.

If booking fails: when a booking tool says the booking did not go through, tell the prospect the booking did not go through and stop there. Never promise an email, a text or a call-back. Do not offer an email. If the prospect asks for the email themselves, follow the email sequence above.

If the prospect says no or asks not to be called again, thank them and call end_call_polite.`

// ---- Conversation flow (section 7a) ---------------------------------------------
// The first node is a deterministic Speak node: the caller hears the disclosure exactly as
// rendered, with no model turn. The top-level greeting field is NOT used for this.
export const CONVERSATION_FLOW = {
	start_node: 'disclosure',
	nodes: [
		{ id: 'disclosure', type: 'speak', text: '{{disclosure_text}}', next: 'agent' },
		{ id: 'agent', type: 'llm' },
	],
} as const

// ---- Payload and content hash ---------------------------------------------------

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
	}
	return JSON.stringify(value)
}

/**
 * Hash of everything that defines what the assistant says and can do. Excludes the
 * webhook URL and the knowledge tool ids, which are environment, not script. This is the
 * script_version stored on the consent record, so a recording can be tied to exact wording.
 */
export function assistantContentHash(): string {
	return createHash('sha256')
		.update(
			stableStringify({
				model: ASSISTANT_MODEL,
				instructions: SYSTEM_PROMPT,
				tools: DECLARED_TOOLS,
				conversation_flow: CONVERSATION_FLOW,
				disclosure: { en: DISCLOSURE_EN, da: DISCLOSURE_DA },
			}),
		)
		.digest('hex')
}

/** Computed once; the router stamps it on every consent record. */
export const SCRIPT_VERSION = assistantContentHash()

const HASH_MARKER = 'maskin-script:'

export interface AssistantPayloadOptions {
	/** Where Telnyx posts tool calls: <public url>/api/integrations/telnyx/webhook */
	webhookUrl: string
	/** Telnyx-side tool ids, e.g. the knowledge RetrievalTool. */
	toolIds?: readonly string[]
}

export function buildAssistantPayload(opts: AssistantPayloadOptions): AssistantPayload {
	return {
		name: 'Maskin Sales Rep (Voice)',
		description: `${HASH_MARKER}${SCRIPT_VERSION}`,
		model: ASSISTANT_MODEL,
		instructions: SYSTEM_PROMPT,
		tools: DECLARED_TOOLS.map((t) => ({
			type: 'webhook',
			webhook: {
				name: t.name,
				description: t.description,
				url: opts.webhookUrl,
				method: 'POST',
				body_parameters: t.parameters,
			},
		})),
		tool_ids: [...(opts.toolIds ?? [])],
		conversation_flow: CONVERSATION_FLOW,
	}
}

export type SyncAssistantResult =
	| { action: 'created'; assistantId: string }
	| { action: 'updated'; assistantId: string }
	| { action: 'unchanged'; assistantId: string }

/**
 * Creates or updates the assistant so it matches this code, and only when it does not
 * already: the stored description carries the content hash, so a redeploy with no script
 * change is a single GET. A created assistant's id has to be put in TELNYX_ASSISTANT_ID by a
 * person; nothing here writes env.
 */
export async function syncAssistant(
	client: TelnyxClient,
	opts: AssistantPayloadOptions & { assistantId: string | null },
): Promise<SyncAssistantResult> {
	const existing = opts.assistantId ? await client.getAssistant(opts.assistantId) : null
	if (!existing) {
		const created = await client.createAssistant(buildAssistantPayload(opts))
		logger.info('telnyx assistant created', {
			assistantId: created.id,
			note: 'set TELNYX_ASSISTANT_ID to this id',
		})
		return { action: 'created', assistantId: created.id }
	}

	const sameScript = existing.description === `${HASH_MARKER}${SCRIPT_VERSION}`
	const wantedTools = [...(opts.toolIds ?? [])].sort()
	const sameTools =
		existing.toolIds.length === wantedTools.length &&
		[...existing.toolIds].sort().every((id, i) => id === wantedTools[i])
	if (sameScript && sameTools) return { action: 'unchanged', assistantId: existing.id }

	await client.updateAssistant(existing.id, buildAssistantPayload(opts))
	logger.info('telnyx assistant updated', { assistantId: existing.id })
	return { action: 'updated', assistantId: existing.id }
}
