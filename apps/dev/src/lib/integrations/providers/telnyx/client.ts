import { z } from '@hono/zod-openapi'
import {
	type DeadLetterHandler,
	TelnyxHttpError,
	type TelnyxFetchOptions,
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
	to: string
	/** Caller id for the transfer leg; defaults to the original call's number. */
	from?: string
	/** Seconds the transfer leg may ring before Telnyx raises call.transfer.failed. */
	timeoutSecs: number
	/** SIP INVITE headers: carries the transcript summary the founder hears first. */
	customHeaders: Array<{ name: string; value: string }>
}

/**
 * Body for POST /v2/ai/assistants and PATCH /v2/ai/assistants/{id}. The shape follows
 * the tech spec (section 2b.2, 2b.6, 7a); it has not been checked against live Telnyx.
 */
export type AssistantPayload = Record<string, unknown>

export interface AssistantRecord {
	id: string
	description: string | null
	toolIds: string[]
}

export interface KnowledgeDocument {
	/** File name inside the bucket, e.g. <knowledge object id>.md */
	name: string
	markdown: string
}

export interface TelnyxClient {
	/** POST /v2/calls with premium AMD. Idempotency-Key: contact_id:dial_attempt_n. */
	createCall(input: CreateCallInput): Promise<CreateCallResult>
	/** POST /v2/calls/{call_id}/actions/hangup. Used to cut the agent off on an AMD machine. */
	hangupCall(callControlId: string): Promise<void>
	/** POST /v2/messages. */
	sendMessage(input: SendMessageInput): Promise<{ messageId: string | null }>
	/** POST /v2/calls/{call_id}/actions/transfer with warm: true. Used on a hot flag_interest. */
	transferCall(callControlId: string, input: TransferCallInput): Promise<void>
	/** GET /v2/ai/assistants/{id}; null when Telnyx answers 404. */
	getAssistant(id: string): Promise<AssistantRecord | null>
	/** POST /v2/ai/assistants. */
	createAssistant(payload: AssistantPayload): Promise<AssistantRecord>
	/** PATCH /v2/ai/assistants/{id}. */
	updateAssistant(id: string, payload: AssistantPayload): Promise<AssistantRecord>
	/**
	 * Replaces the contents of a knowledge bucket and re-embeds it: bucket create (exists is
	 * fine), one object upload per document, then the embed call. Returns the retrieval tool id
	 * to attach to the assistant. Endpoints are UNVERIFIED against live Telnyx.
	 */
	syncKnowledgeBucket(
		bucketName: string,
		documents: readonly KnowledgeDocument[],
	): Promise<{ retrievalToolId: string }>
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
			tool_ids: z.array(z.string()).optional(),
		})
		.passthrough(),
})

const knowledgeSyncResponseSchema = z.object({
	data: z.object({ tool_id: z.string() }).passthrough(),
})

function toAssistantRecord(raw: unknown): AssistantRecord {
	const { data } = assistantResponseSchema.parse(raw)
	return { id: data.id, description: data.description ?? null, toolIds: data.tool_ids ?? [] }
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

		async transferCall(callControlId, input) {
			await request('POST', `/v2/calls/${encodeURIComponent(callControlId)}/actions/transfer`, {
				to: input.to,
				from: input.from,
				warm: true,
				timeout_secs: input.timeoutSecs,
				custom_headers: input.customHeaders,
			})
		},

		async getAssistant(id) {
			try {
				const res = await request('GET', `/v2/ai/assistants/${encodeURIComponent(id)}`, undefined)
				return toAssistantRecord(await res.json())
			} catch (err) {
				if (err instanceof TelnyxHttpError && err.status === 404) return null
				throw err
			}
		},

		async createAssistant(payload) {
			const res = await request('POST', '/v2/ai/assistants', payload)
			return toAssistantRecord(await res.json())
		},

		async updateAssistant(id, payload) {
			const res = await request('PATCH', `/v2/ai/assistants/${encodeURIComponent(id)}`, payload)
			return toAssistantRecord(await res.json())
		},

		async syncKnowledgeBucket(bucketName, documents) {
			const bucket = encodeURIComponent(bucketName)
			try {
				await request('POST', '/v2/ai/embeddings/buckets', { name: bucketName })
			} catch (err) {
				// 409 or 422 on a bucket that already exists is the normal nightly case.
				if (!(err instanceof TelnyxHttpError && (err.status === 409 || err.status === 422))) throw err
			}
			for (const doc of documents) {
				await request(
					'PUT',
					`/v2/ai/embeddings/buckets/${bucket}/objects/${encodeURIComponent(doc.name)}`,
					{ content: doc.markdown, content_type: 'text/markdown' },
				)
			}
			const res = await request('POST', '/v2/ai/embeddings', { bucket_name: bucketName })
			return { retrievalToolId: knowledgeSyncResponseSchema.parse(await res.json()).data.tool_id }
		},
	}
}
