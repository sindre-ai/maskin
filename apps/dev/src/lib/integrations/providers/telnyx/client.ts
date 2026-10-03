import { z } from '@hono/zod-openapi'
import { type DeadLetterHandler, type TelnyxFetchOptions, telnyxFetch } from './http'

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

export interface TelnyxClient {
	/** POST /v2/calls with premium AMD. Idempotency-Key: contact_id:dial_attempt_n. */
	createCall(input: CreateCallInput): Promise<CreateCallResult>
	/** POST /v2/calls/{call_id}/actions/hangup. Used to cut the agent off on an AMD machine. */
	hangupCall(callControlId: string): Promise<void>
	/** POST /v2/messages. */
	sendMessage(input: SendMessageInput): Promise<{ messageId: string | null }>
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
	}
}
