import { z } from '@hono/zod-openapi'
import {
	type DeadLetterHandler,
	type TelnyxFetchOptions,
	TelnyxHttpError,
	telnyxFetch,
} from './http'

const TELNYX_API_BASE = 'https://api.telnyx.com'

/**
 * What the dialer stamps onto a call so webhooks can find their way back to the
 * contact. Carried in Telnyx's client_state (base64 JSON), which Telnyx echoes
 * on every event for the call.
 */
export const callClientStateSchema = z.object({
	contact_id: z.string().uuid(),
	workspace_id: z.string().uuid(),
	dial_attempt_n: z.number().int().positive(),
	/** Set only by the transfer command: the Leg A call_control_id the transfer started from. */
	transfer_of: z.string().min(1).optional(),
})
export type CallClientState = z.infer<typeof callClientStateSchema>

export function encodeClientState(state: CallClientState): string {
	return Buffer.from(JSON.stringify(callClientStateSchema.parse(state)), 'utf8').toString('base64')
}

export function decodeClientState(raw: string | null | undefined): CallClientState | null {
	if (!raw) return null
	try {
		const parsed = callClientStateSchema.safeParse(
			JSON.parse(Buffer.from(raw, 'base64').toString('utf8')),
		)
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

export interface CreateCallInput {
	to: string
	from: string
	assistantId: string
	connectionId: string
	webhookUrl: string
	clientState: CallClientState
}

export interface CreateCallResult {
	callControlId: string
	callSessionId: string | null
}

export interface SendMessageInput {
	from: string
	to: string
	text: string
	/** contact_id:dial_attempt_n */
	idempotencyKey?: string
}

export interface TransferCallInput {
	callControlId: string
	to: string
	/** SIP INVITE headers; carries the transcript summary to the person who picks up. */
	customHeaders?: Array<{ name: string; value: string }>
	/** Seconds Telnyx waits for the destination to answer before giving up. */
	timeoutSecs: number
	/** Echoed on Leg B's events, so they find their way back to the contact and to Leg A. */
	clientState: CallClientState
}

/** Telnyx AI assistant body (POST /v2/ai/assistants). Shape: Telnyx OpenAPI CreateAssistantRequest. */
export type AssistantPayload = Record<string, unknown>

export interface TelnyxAssistant {
	id: string
	description: string | null
	toolIds: string[]
}

export interface TelnyxClient {
	/** POST /v2/calls with premium AMD. Idempotency-Key: contact_id:dial_attempt_n. */
	createCall(input: CreateCallInput): Promise<CreateCallResult>
	/** POST /v2/calls/{call_id}/actions/hangup. Used to cut the agent off on an AMD machine. */
	hangupCall(callControlId: string): Promise<void>
	/** POST /v2/messages. */
	sendMessage(input: SendMessageInput): Promise<{ messageId: string | null }>
	/** POST /v2/calls/{call_id}/actions/transfer. */
	transferCall(input: TransferCallInput): Promise<void>
	/** GET /v2/ai/assistants/{id}. Null when it does not exist. */
	getAssistant(assistantId: string): Promise<TelnyxAssistant | null>
	/** POST /v2/ai/assistants. */
	createAssistant(payload: AssistantPayload): Promise<TelnyxAssistant>
	/** POST /v2/ai/assistants/{id} (Telnyx updates with POST, not PATCH). */
	updateAssistant(assistantId: string, payload: AssistantPayload): Promise<TelnyxAssistant>
	/** POST /v2/ai/embeddings: embed the documents in a Telnyx Storage bucket. */
	embedBucket(bucketName: string): Promise<void>
	/** The id of the shared retrieval tool over a bucket, created on first use. */
	ensureRetrievalTool(displayName: string, bucketName: string): Promise<string>
}

export interface TelnyxClientOptions {
	apiKey: string
	onDeadLetter?: DeadLetterHandler
	baseUrl?: string
	/** Test seams, forwarded to telnyxFetch. */
	fetchImpl?: typeof fetch
	sleep?: TelnyxFetchOptions['sleep']
	random?: TelnyxFetchOptions['random']
}

const createCallResponseSchema = z.object({
	data: z.object({
		call_control_id: z.string(),
		call_session_id: z.string().optional(),
	}),
})

const sendMessageResponseSchema = z.object({
	data: z.object({ id: z.string().optional() }).passthrough(),
})

const assistantResponseSchema = z.object({
	data: z
		.object({
			id: z.string(),
			description: z.string().nullish(),
			tool_ids: z.array(z.string()).nullish(),
		})
		.passthrough(),
})

const sharedToolSchema = z
	.object({ id: z.string(), display_name: z.string().nullish() })
	.passthrough()
const sharedToolListSchema = z.object({ data: z.array(sharedToolSchema) })

function toAssistant(raw: unknown): TelnyxAssistant {
	const parsed = assistantResponseSchema.parse(raw).data
	return { id: parsed.id, description: parsed.description ?? null, toolIds: parsed.tool_ids ?? [] }
}

export function createTelnyxClient(opts: TelnyxClientOptions): TelnyxClient {
	const base = opts.baseUrl ?? TELNYX_API_BASE

	async function request(
		method: string,
		path: string,
		body: unknown,
		idempotencyKey?: string,
	): Promise<Response> {
		return telnyxFetch(`${base}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${opts.apiKey}`,
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			idempotencyKey,
			onDeadLetter: opts.onDeadLetter,
			fetchImpl: opts.fetchImpl,
			sleep: opts.sleep,
			random: opts.random,
		})
	}

	return {
		async createCall(input) {
			const res = await request(
				'POST',
				'/v2/calls',
				{
					to: input.to,
					from: input.from,
					connection_id: input.connectionId,
					assistant_id: input.assistantId,
					webhook_url: input.webhookUrl,
					answering_machine_detection: 'premium',
					client_state: encodeClientState(input.clientState),
				},
				`${input.clientState.contact_id}:${input.clientState.dial_attempt_n}`,
			)
			const parsed = createCallResponseSchema.parse(await res.json())
			return {
				callControlId: parsed.data.call_control_id,
				callSessionId: parsed.data.call_session_id ?? null,
			}
		},

		async hangupCall(callControlId) {
			await request('POST', `/v2/calls/${encodeURIComponent(callControlId)}/actions/hangup`, {})
		},

		async sendMessage(input) {
			const res = await request(
				'POST',
				'/v2/messages',
				{ from: input.from, to: input.to, text: input.text },
				input.idempotencyKey,
			)
			const parsed = sendMessageResponseSchema.parse(await res.json())
			return { messageId: parsed.data.id ?? null }
		},

		async transferCall(input) {
			await request(
				'POST',
				`/v2/calls/${encodeURIComponent(input.callControlId)}/actions/transfer`,
				{
					to: input.to,
					timeout_secs: input.timeoutSecs,
					client_state: encodeClientState(input.clientState),
					...(input.customHeaders ? { custom_headers: input.customHeaders } : {}),
				},
			)
		},

		async getAssistant(assistantId) {
			try {
				const res = await request(
					'GET',
					`/v2/ai/assistants/${encodeURIComponent(assistantId)}`,
					undefined,
				)
				return toAssistant(await res.json())
			} catch (err) {
				if (err instanceof TelnyxHttpError && err.status === 404) return null
				throw err
			}
		},

		async createAssistant(payload) {
			const res = await request('POST', '/v2/ai/assistants', payload)
			return toAssistant(await res.json())
		},

		async updateAssistant(assistantId, payload) {
			const res = await request(
				'POST',
				`/v2/ai/assistants/${encodeURIComponent(assistantId)}`,
				payload,
			)
			return toAssistant(await res.json())
		},

		async ensureRetrievalTool(displayName, bucketName) {
			const list = await request(
				'GET',
				`/v2/ai/tools?filter[name]=${encodeURIComponent(displayName)}&filter[type]=retrieval`,
				undefined,
			)
			const found = sharedToolListSchema
				.parse(await list.json())
				.data.find((t) => t.display_name === displayName)
			if (found) return found.id
			const created = await request('POST', '/v2/ai/tools', {
				type: 'retrieval',
				display_name: displayName,
				retrieval: { bucket_ids: [bucketName] },
			})
			return z.object({ data: sharedToolSchema }).parse(await created.json()).data.id
		},

		async embedBucket(bucketName) {
			await request('POST', '/v2/ai/embeddings', { bucket_name: bucketName })
		},
	}
}
