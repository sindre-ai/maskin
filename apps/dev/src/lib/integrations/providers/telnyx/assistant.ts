import { createHash } from 'node:crypto'
import type { TelnyxAssistant, TelnyxClient } from './client'
import { TOOL_DECLARATIONS } from './tool-schemas'

export const ASSISTANT_MODEL = 'anthropic/claude-haiku-4-5'
export const ASSISTANT_NAME = 'Maskin Sales Rep (Voice)'
const HASH_PREFIX = 'maskin-voice-assistant:'

export type DisclosureLocale = 'en' | 'da'

/**
 * The fixed opener (tech spec 7a). Delivered by a Speak node, so the model never sees a turn
 * before it. Wording is a positioning and compliance call that still needs sign-off from the
 * product and positioning human on the bet; this is the template from the spec.
 */
export const DISCLOSURE_TEMPLATES: Record<DisclosureLocale, string> = {
	en: 'Hi {{prospect_first_name}}, this is an AI assistant calling on behalf of Maskin, do you have a moment?',
	da: 'Hej {{prospect_first_name}}, det her er en AI-assistent, der ringer på vegne af Maskin, har du et øjeblik?',
}

/** What the call.hangup assertion looks for in the first thing the agent said (spec 7a, step 4). */
export const DISCLOSURE_PATTERNS: readonly RegExp[] = [/AI[- ]?assist/i, /AI[- ]?assistent/i]

/**
 * System prompt, layer 1 of section 2b.6: the guardrails and the rules for the five tools. The
 * elevator pitch and FAQ copy are not here: they belong to the Sales Rep (Voice) prompt task, and
 * the agent answers company questions from the retrieved knowledge or defers to the meeting.
 */
export const SYSTEM_PROMPT = `You are an AI assistant calling on behalf of Maskin. You are not a person and you never speak as one. Speak the language the prospect speaks, Danish or English. Keep every turn short. Your job is to book a meeting with Sebastian, not to close a deal.

The call has already opened with a fixed greeting that says you are an AI assistant. Do not repeat it. If the prospect asks, say plainly that you are an AI assistant.

Guardrails:
- Never state a price, a discount or an ROI number. Sebastian covers that on the meeting.
- Never name customers, revenue or funding.
- Never promise a date for an integration or a feature.
- Never say "I have been building this" or "we launched". You are an assistant, not a founder.
- Answer questions about Maskin only from the knowledge you retrieve. If you are not sure, say: "Good question, Sebastian will walk you through that on the meeting, want me to book a slot?" and treat it as a cue to book.

Available actions (five tools):
- book_meeting_slot: get 3 free times. Read them aloud.
- confirm_meeting_slot: book the one the prospect picked (slot_index 1, 2 or 3).
- flag_interest: strength hot when they want to talk to a person now, warm when they are open to it later.
- end_call_polite: end the call.
- request_followup_email: record that the prospect asked for one follow-up email.

Sequencing: when the prospect shows warm or hot interest, call flag_interest, then book_meeting_slot, then confirm_meeting_slot, and only then end_call_polite. Never end the call on an interested prospect before the meeting is confirmed or the booking has failed.

Email. Never offer to send an email. Only if the prospect raises email themselves:
1. Confirm the address you hold for them.
2. In one short, neutral sentence say the one email comes from Maskin and that they can opt out at any time. No pitch.
3. Wait for their answer.
4. Only if they say yes, call request_followup_email with their words and your own last sentence before their yes. If they give a different address, do not call the tool.

If a booking fails: say the booking did not go through and promise nothing outbound. No email, no text, no call-back. Never offer an email. If the prospect asks for the email themselves, follow the email steps above.

Never send or offer a text message.`

export interface AssistantPayloadInput {
	locale: DisclosureLocale
	/** https://<host>/api/integrations/telnyx/webhook */
	toolWebhookUrl: string
	/** Telnyx shared tool ids attached alongside the five (the knowledge RetrievalTool). */
	toolIds?: readonly string[]
}

const DISCLOSURE_NODE_ID = 'n_disclosure'
const AGENT_NODE_ID = 'n_agent'

/**
 * The create/update body for the Telnyx assistant. The first node of the conversation flow is a
 * Speak node: a deterministic step with no model turn, so the disclosure is heard verbatim. The
 * top-level greeting field is not used for it because it is only a template.
 */
export function buildAssistantPayload(input: AssistantPayloadInput): Record<string, unknown> {
	return {
		name: ASSISTANT_NAME,
		model: ASSISTANT_MODEL,
		instructions: SYSTEM_PROMPT,
		dynamic_variables: { prospect_first_name: '' },
		tools: TOOL_DECLARATIONS.map((tool) => ({
			type: 'webhook',
			webhook: {
				name: tool.name,
				description: tool.description,
				url: input.toolWebhookUrl,
				method: 'POST',
				body_parameters: tool.parameters,
				// Supplied by the assistant configuration, never by the model.
				preset_body_fields: { call_control_id: '{{telnyx_call_control_id}}' },
			},
		})),
		tool_ids: [...(input.toolIds ?? [])],
		conversation_flow: {
			start_node_id: DISCLOSURE_NODE_ID,
			nodes: [
				{
					type: 'speak',
					id: DISCLOSURE_NODE_ID,
					name: 'AI disclosure',
					message: DISCLOSURE_TEMPLATES[input.locale],
				},
				{
					type: 'prompt',
					id: AGENT_NODE_ID,
					name: 'Agent',
					instructions: SYSTEM_PROMPT,
				},
			],
			edges: [
				{
					id: 'e_disclosure_to_agent',
					start_node_id: DISCLOSURE_NODE_ID,
					target: { type: 'node', node_id: AGENT_NODE_ID },
					condition: { type: 'default' },
				},
			],
		},
	}
}

/** Stable JSON: object keys sorted, so the hash does not depend on construction order. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
		return `{${entries.join(',')}}`
	}
	return JSON.stringify(value)
}

/**
 * The assistant content hash: script_version in the consent audit record, and the marker that
 * lets an unchanged assistant skip the update call. Computed over the script (prompt, tools,
 * flow) without the description field, where the hash itself is stored, and without tool_ids:
 * the knowledge base changes on its own schedule and is not the script.
 */
export function assistantContentHash(payload: Record<string, unknown>): string {
	const { description: _omitted, tool_ids: _kb, ...rest } = payload
	return createHash('sha256').update(canonical(rest)).digest('hex').slice(0, 16)
}

export function readDisclosureLocale(env: NodeJS.ProcessEnv = process.env): DisclosureLocale {
	return env.VOICE_DISCLOSURE_LOCALE?.trim().toLowerCase() === 'en' ? 'en' : 'da'
}

/** The hash of the assistant this deploy would create, from env. Used as script_version at tool time. */
export function currentScriptVersion(env: NodeJS.ProcessEnv = process.env): string {
	const base = env.MASKIN_PUBLIC_URL?.trim().replace(/\/+$/, '') ?? ''
	return assistantContentHash(
		buildAssistantPayload({
			locale: readDisclosureLocale(env),
			toolWebhookUrl: `${base}/api/integrations/telnyx/webhook`,
		}),
	)
}

export type EnsureAssistantResult =
	| { action: 'created' | 'updated'; assistantId: string; hash: string }
	| { action: 'unchanged'; assistantId: string; hash: string }

/**
 * Creates the assistant, or updates it when the content hash differs from the one stored in its
 * description. Running it twice with the same content makes no write the second time.
 */
export async function ensureAssistant(
	client: TelnyxClient,
	params: { assistantId: string | null; payload: Record<string, unknown> },
): Promise<EnsureAssistantResult> {
	const hash = assistantContentHash(params.payload)
	const body = { ...params.payload, description: `${HASH_PREFIX}${hash}` }

	const existing = params.assistantId ? await client.getAssistant(params.assistantId) : null
	if (!existing) {
		const created: TelnyxAssistant = await client.createAssistant(body)
		return { action: 'created', assistantId: created.id, hash }
	}
	if (existing.description === `${HASH_PREFIX}${hash}`) {
		return { action: 'unchanged', assistantId: existing.id, hash }
	}
	await client.updateAssistant(existing.id, body)
	return { action: 'updated', assistantId: existing.id, hash }
}
