import { z } from 'zod'
import { mcpServerSchema } from './sessions'

export const eventDefinitionSchema = z.object({
	entityType: z.string(),
	actions: z.array(z.string()),
	label: z.string(),
})

/**
 * The MCP surface a provider exposes, served so that non-browser clients can
 * discover it. Before this existed the only description of "what JSON attaches
 * this integration's tools to an agent" lived in a frontend constant, so an
 * agent driving Maskin over MCP could complete an OAuth handshake and then had
 * no way to find out that the integration had any tools at all.
 */
export const providerMcpInfoSchema = z.object({
	/** Env var session-manager injects the OAuth access token as. */
	envKey: z.string(),
	/**
	 * True when every agent session in a workspace with this integration active
	 * already gets `server` attached, so no per-agent config is needed.
	 */
	autoInject: z.boolean(),
	/**
	 * Paste-ready spec for `tools.mcpServers.<provider>` on an agent. Env
	 * placeholders (`${TOKEN}`) are expanded inside the session container — pass
	 * them through verbatim rather than resolving them.
	 */
	server: mcpServerSchema.optional(),
})

export const providerInfoSchema = z.object({
	name: z.string(),
	displayName: z.string(),
	events: z.array(eventDefinitionSchema),
	/** Absent when the provider has no MCP server. */
	mcp: providerMcpInfoSchema.optional(),
})

export const providerParamsSchema = z.object({
	provider: z.string().min(1),
})

export const integrationParamsSchema = z.object({
	id: z.string().uuid(),
})

/**
 * Gmail Pub/Sub push envelope. Google publishes a base64-encoded JSON blob in
 * `message.data` whose decoded shape is `{ emailAddress, historyId }`.
 */
export const gmailPubsubEnvelopeSchema = z.object({
	subscription: z.string(),
	message: z.object({
		data: z.string(),
		messageId: z.string().optional(),
		publishTime: z.string().optional(),
	}),
})

export const gmailPubsubMessageDataSchema = z.object({
	emailAddress: z.string().email(),
	historyId: z.union([z.string(), z.number()]).transform((v) => String(v)),
})

/** Converts a GitHub org/user login to the env var suffix used for its token (e.g. "sindre-ai" → "SINDRE_AI"). */
export function githubOwnerLoginToEnvKey(ownerLogin: string): string {
	return ownerLogin.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

/** Mirrors Skjald's `DiarizedSegment` (webhooks/events.rs). */
export const skjaldDiarizedSegmentSchema = z.object({
	transcript_id: z.string(),
	speaker_id: z.string(),
	speaker_name: z.string(),
	audio_start_time: z.number().nullable().optional(),
	audio_end_time: z.number().nullable().optional(),
})

/** Mirrors Skjald's `TranscriptionCompletedPayload` (webhooks/events.rs). */
export const skjaldTranscriptionCompletedPayloadSchema = z.object({
	meeting_id: z.string().min(1),
	meeting_title: z.string().min(1),
	segment_count: z.number(),
	folder_path: z.string().nullable().optional(),
	created_at: z.string(),
	// Only present when the webhook's payload mode is "Full content".
	transcript_text: z.string().nullable().optional(),
	diarization_status: z.string(),
	// Only present when `diarization_status` is `"completed"`.
	speaker_segments: z.array(skjaldDiarizedSegmentSchema).nullable().optional(),
})

export type SkjaldDiarizedSegment = z.infer<typeof skjaldDiarizedSegmentSchema>
export type SkjaldTranscriptionCompletedPayload = z.infer<
	typeof skjaldTranscriptionCompletedPayloadSchema
>

/**
 * "Connect with Maskin" from the Skjald app: the page the app opens, and the two calls behind it. The only
 * redirect the app can receive is its own custom scheme, so the code never travels through a shared origin.
 */
export const SKJALD_CONNECT_REDIRECT_URI = 'skjald://connect/maskin'

export const skjaldConnectAuthorizeBodySchema = z.object({
	state: z.string().min(8).max(256),
	redirect_uri: z.string().max(200),
	/** PKCE S256: base64url(SHA-256(code_verifier)), always 43 characters. */
	code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	code_challenge_method: z.literal('S256'),
})

export const skjaldConnectAuthorizeResponseSchema = z.object({
	/** `skjald://connect/maskin?code=…&state=…`: where the page sends the browser. */
	redirect_url: z.string(),
	workspace_name: z.string(),
})

export const skjaldConnectExchangeBodySchema = z.object({
	code: z.string().min(20).max(200),
	code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
})

export const skjaldConnectExchangeResponseSchema = z.object({
	webhook_url: z.string(),
	secret: z.string(),
	workspace_name: z.string(),
})
