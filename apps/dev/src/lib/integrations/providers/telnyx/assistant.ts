import { createHash } from 'node:crypto'
import type { TelnyxAssistant, TelnyxClient } from './client'
import { TOOL_DECLARATIONS } from './tool-schemas'

export const ASSISTANT_MODEL = 'anthropic/claude-haiku-4-5'
/** The assistant's name in the Telnyx portal. */
export const ASSISTANT_NAME = 'Rune Værk'
/** What the assistant calls itself on the call, in the opener and the prompt. Never the surname. */
export const ASSISTANT_FIRST_NAME = 'Rune'
const HASH_PREFIX = 'maskin-voice-assistant:'

export type DisclosureLocale = 'en' | 'da'

/**
 * The fixed opener (tech spec 7a). Delivered by a Speak node, so the model never sees a turn
 * before it. The da text is the verbatim opener of the live assistant. The en text is a plain
 * translation, not live, and unused while DISCLOSURE_LOCALE is da.
 */
export const DISCLOSURE_TEMPLATES: Record<DisclosureLocale, string> = {
	en: `Hello, my name is ${ASSISTANT_FIRST_NAME}, and I am an AI agent working for the company Maskin. I would like to hear whether you are interested in hearing more about how you can hire AI agents to do the operational work at your company.`,
	da: `Hej, jeg hedder ${ASSISTANT_FIRST_NAME}, og jeg er en AI Agent, der arbejder for virksomheden Maskin. Jeg vil høre om I er interesseret i at høre mere om, hvordan I kan hyre AI Agenter til at udføre det operationelle arbejde hos jer, så I får mere tid til at fokusere på forretningen.`,
}

/** The greeting for a contact with no first name. Danish like the opener, see DISCLOSURE_LOCALE. */
export const DEFAULT_PROSPECT_GREETING = 'Hej'

/** What the call.hangup assertion looks for in the first thing the agent said (spec 7a, step 4). */
export const DISCLOSURE_PATTERNS: readonly RegExp[] = [
	/AI[- ]?assist/i,
	/AI[- ]?assistent/i,
	/AI[- ]?agent/i,
]

/**
 * System prompt, layer 1 of section 2b.6: the Danish prompt of the live assistant, copied from the
 * live read of 2026-10-28. Change it here and ship a PR: a portal edit is overwritten by the
 * next ensureAssistant run.
 */
export const SYSTEM_PROMPT = `Du hedder ${ASSISTANT_FIRST_NAME}. Du er en AI-agent, der ringer på vegne af Maskin. Du er ikke et menneske, og du udgiver dig aldrig for at være et. Hvis nogen spørger om dit navn, sig "${ASSISTANT_FIRST_NAME}, en AI-agent fra Maskin". Sig ikke et efternavn.

SPROG OG TONE
Tal dansk som standard, roligt, venligt og professionelt. Skift kun til engelsk, hvis modparten taler engelsk. Hold hvert svar kort, en til to sætninger, som i en rigtig telefonsamtale. Stil højst et spørgsmål ad gangen.

MÅL
Skab en god samtale om, hvordan AI-agenter kan overtage operationelt arbejde hos modparten. Først når modparten viser reel interesse, booker du et møde med Sebastian. Du lukker ikke en handel på telefonen.

Åbningen er allerede sagt: hilsen, dit navn og at du er en AI-agent. Gentag den ikke. Hvis modparten spørger, så sig ligeud, at du er en AI-agent.

SAMTALEFORLØB (book ikke for hurtigt)
1. Lyt til det første svar. Hvis modparten er afvisende, så accepter det høfligt (se nedenfor).
2. Hvis modparten er nysgerrig eller siger ja til at høre mere: forklar kort, hvad Maskin er, i to til tre sætninger fra afsnittet "Om Maskin". Stil derefter et åbent spørgsmål om deres operationelle arbejde, for eksempel hvilke gentagne opgaver der fylder mest hos dem.
3. Svar på spørgsmål undervejs. Gå i dybden, hvis de spørger, og brug konkrete eksempler på operationelt arbejde, som agenter kan tage. Hold dig til afsnittet "Om Maskin" og den viden, du kan hente. Opfind ikke.
4. Foreslå først et møde, når modparten har vist reel interesse efter mindst to udvekslinger, eller selv spørger efter næste skridt. Så kalder du flag_interest og følger bookingforløbet nedenfor.
5. Hvis modparten ikke er interesseret, så afslut venligt med end_call_polite.

OM MASKIN (det du må sige)
- Maskin er et arbejdsrum, hvor mennesker og AI-agenter arbejder sammen om de samme mål.
- Agenterne har en rolle ligesom en medarbejder og arbejder selvstændigt på opgaver, for eksempel research, opfølgning, support og administrativt arbejde.
- Man kan hyre agenter til det operationelle arbejde, så teamet bruger tiden på det, der kræver mennesker.
- Agenterne forbindes til de værktøjer, virksomheden allerede bruger, for eksempel mail, kalender og Slack.
- Alt agenterne gør, er synligt for teamet, og mennesker kan altid se, rette og godkende.
- Maskin er et dansk firma, Maskin ApS.
Hvis du er i tvivl om noget, sig: "Godt spørgsmål, Sebastian gennemgår det gerne på mødet, skal jeg booke et tidspunkt?"

GUARDRAILS (brydes aldrig)
- Never state a price, a discount or an ROI number. Sebastian covers that on the meeting.
- Never name customers, revenue or funding.
- Never promise a date for an integration or a feature.
- Never say "I have been building this" or "we launched". You are an AI agent, not a founder.
- Never claim a capability that is not listed above or in the knowledge you retrieve.

INDVENDINGER
- Ikke interesseret eller ingen tid: accepter, tak for tiden, end_call_polite. Lov ikke at ringe igen.
- Beder om ikke at blive kontaktet igen: undskyld en gang, end_call_polite.
- Hvem har givet dig mit nummer: "Vi ringer til udvalgte virksomheder, vi tror kan have glæde af det. Vil du ikke kontaktes igen, noterer jeg det med det samme." Er de utilfredse, så afslut venligt.
- Vi har allerede en løsning: spørg kort, hvad den dækker, og forklar, at Maskin handler om, at agenter tager det operationelle arbejde.
- Hvis du når en telefonsvarer: læg på uden at indtale en besked.

Available actions (five tools):
- book_meeting_slot: get 3 free times. Read them aloud.
- confirm_meeting_slot: book the one the prospect picked (slot_index 1, 2 or 3).
- flag_interest: strength hot when they want to talk to a person now, warm when they are open to it later.
- end_call_polite: end the call.
- request_followup_email: record that the prospect asked for one follow-up email.

BOOKING
Når modparten har vist reel interesse: kald flag_interest, derefter book_meeting_slot og læs de tre tider højt, derefter confirm_meeting_slot for den tid, de vælger, og først derefter end_call_polite. Afslut aldrig en interesseret samtale, før mødet er bekræftet, eller bookingen er fejlet. Hvis bookingen fejler, så sig, at bookingen ikke gik igennem, og lov intet udgående: ingen mail, ingen sms, intet tilbagekald.

EMAIL (streng, samtykkebaseret)
- Tilbyd aldrig at sende en mail. Handl kun, hvis modparten selv tager mail op.
- Hvis de gør det, og du har en mailadresse på kontakten, så sig præcis en kort bekræftelse: "Bare for at bekræfte: en e-mail fra Maskin til den adresse vi har på dig, og du kan til enhver tid framelde dig. Er det i orden?"
- Vent på svaret. Kun ved et klart ja kalder du request_followup_email med modpartens egne ord og din egen sidste sætning før deres ja. Giver de en anden adresse, eller svarer de noget andet, så kald ikke værktøjet.
- Har kontakten ingen mailadresse, så kør ikke forløbet.

Send aldrig og tilbyd aldrig sms.

TIDSPUNKTER (sådan siger du dem)
- Sig tider som en dansker taler: "klokken 14", "klokken 14.30" eller "halv tre". Sig aldrig 14:00 som "fjorten nul nul" eller "fjorten hundrede", og brug ikke militærtid eller engelsk.
- Sig altid ugedag, dato og klokkeslæt, for eksempel "tirsdag den 21. oktober klokken 14".
- Tiderne fra book_meeting_slot kommer i UTC. Omregn til dansk tid, før du siger dem: UTC plus 2 timer indtil 25. oktober 2026, derefter UTC plus 1 time. Foreslåede tider ligger altid mellem klokken 10 og 16 dansk tid. Passer en tid ikke til det, har du omregnet forkert.
- Læs de tre tider højt kort og tydeligt, og spørg, hvilken der passer bedst.`

export interface AssistantPayloadInput {
	locale: DisclosureLocale
	/**
	 * TELNYX_TOOL_WEBHOOK_SECRET. Sent as the Authorization header on every tool. Never log the
	 * payload: it carries this value.
	 */
	toolWebhookSecret: string
	/** https://<host>/api/integrations/telnyx/tools: each tool posts to <this>/<tool name>. */
	toolsBaseUrl: string
	/** Telnyx shared tool ids attached alongside the five (the knowledge RetrievalTool). */
	toolIds?: readonly string[]
}

const CONVERSATION_NODE_INSTRUCTIONS =
	'Den danske AI-hilsen er lige blevet sagt. Vent på modpartens svar, og fortsæt derefter samtalen efter assistentens instruktioner.'
const DISCLOSURE_NODE_ID = 'n_disclosure'
const AGENT_NODE_ID = 'n_agent'

/**
 * Every webhook tool is a synchronous POST with a 5 second budget. Telnyx reads it from the tool
 * itself, next to "type": a timeout_ms inside the webhook object is stored but not applied.
 */
const TOOL_TIMEOUT_MS = 5000

/**
 * The only tool that ends a call: end_call_polite just records the outcome and replies, it does
 * not hang up. Same type and description as the shared "Default hangup" tool of the live assistant.
 */
const HANGUP_TOOL = {
	type: 'hangup',
	hangup: {
		description:
			'To be used whenever the conversation has ended and it would be appropriate to hangup the call.',
	},
}

/**
 * Voice, speech-to-text, interruption and post-call settings, as read from the live assistant on
 * 2026-10-28 (null and empty values left out). Sent whole, never in part: an update with a
 * half-filled settings object may reset the rest.
 */
const VOICE_SETTINGS = {
	voice: 'Telnyx.Ultra.926e0766-f380-4d77-aeb0-9aa4ebb16b38',
	voice_speed: 1,
	background_audio: { type: 'predefined_media', value: 'silence', volume: 0.5 },
	similarity_boost: 0.5,
	style: 0,
	use_speaker_boost: true,
	language_boost: 'Danish',
	expressive_mode: false,
}

const TRANSCRIPTION = {
	model: 'deepgram/nova-3',
	language: 'da-DK',
	settings: {
		smart_format: true,
		numerals: true,
		eot_threshold: 0.8,
		eot_timeout_ms: 5000,
		eager_eot_threshold: 0.8,
	},
}

const INTERRUPTION_SETTINGS = {
	enable: true,
	disable_greeting_interruption: false,
	start_speaking_plan: {
		wait_seconds: 0.1,
		transcription_endpointing_plan: {
			on_punctuation_seconds: 0.1,
			on_no_punctuation_seconds: 0.1,
			on_number_seconds: 0.1,
		},
	},
	interrupt_prediction_threshold: 0.55,
}

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
		// Empty on purpose: the opener is the first node of the flow, not the greeting field.
		greeting: '',
		voice_settings: VOICE_SETTINGS,
		transcription: TRANSCRIPTION,
		interruption_settings: INTERRUPTION_SETTINGS,
		post_conversation_settings: { enabled: false },
		tools: [
			HANGUP_TOOL,
			...TOOL_DECLARATIONS.map((tool) => ({
				type: 'webhook',
				timeout_ms: TOOL_TIMEOUT_MS,
				webhook: {
					name: tool.name,
					description: tool.description,
					url: `${input.toolsBaseUrl}/${tool.name}`,
					method: 'POST',
					headers: [{ name: 'Authorization', value: `Bearer ${input.toolWebhookSecret}` }],
					async: false,
					body_parameters: tool.parameters,
					// Supplied by the assistant configuration, never by the model. Telnyx rejects dynamic
					// variable names that start with telnyx_; call_control_id is the system variable.
					preset_body_fields: { call_control_id: '{{call_control_id}}' },
				},
			})),
		],
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
					name: 'Conversation',
					// Appended to the assistant instructions above, so the prompt is not repeated here.
					instructions: CONVERSATION_NODE_INSTRUCTIONS,
					instructions_mode: 'append',
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
 * the knowledge base changes on its own schedule and is not the script. Tool headers count by
 * name only: the secret never shapes script_version, so rotating it keeps the version while
 * dropping the header changes it. (A rotation still needs a manual update of the live assistant.)
 */
export function assistantContentHash(payload: Record<string, unknown>): string {
	const { description: _omitted, tool_ids: _kb, tools, ...rest } = payload
	const hashable = Array.isArray(tools) ? { ...rest, tools: tools.map(withHeaderNamesOnly) } : rest
	return createHash('sha256').update(canonical(hashable)).digest('hex').slice(0, 16)
}

function withHeaderNamesOnly(tool: unknown): unknown {
	const webhook = (tool as { webhook?: { headers?: Array<{ name: string }> } } | null)?.webhook
	if (!webhook?.headers) return tool
	return {
		...(tool as object),
		webhook: { ...webhook, headers: webhook.headers.map((h) => ({ name: h.name })) },
	}
}

// Every call in this bet is Danish (+45 numbers), so the disclosure is Danish. Same rule as
// FOLLOWUP_LANGUAGE in the post-call email hook; no per-contact detection until a second market exists.
export const DISCLOSURE_LOCALE: DisclosureLocale = 'da'

/**
 * The hash of the assistant this deploy would create, from env. Used as script_version at tool
 * time. Throws without MASKIN_PUBLIC_URL: a version hashed over relative tool urls is wrong, and a
 * wrong version in a consent record is worse than a failed call.
 */
export function currentScriptVersion(env: NodeJS.ProcessEnv = process.env): string {
	const base = env.MASKIN_PUBLIC_URL?.trim().replace(/\/+$/, '') ?? ''
	if (base === '') throw new Error('MASKIN_PUBLIC_URL is not set: cannot compute the script version')
	return assistantContentHash(
		buildAssistantPayload({
			locale: DISCLOSURE_LOCALE,
			// Header values are not part of the hash, so the secret is not needed here.
			toolWebhookSecret: '',
			toolsBaseUrl: `${base}/api/integrations/telnyx/tools`,
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
