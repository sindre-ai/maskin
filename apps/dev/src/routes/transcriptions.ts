import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import { createApiError, validationFailureHook } from '../lib/errors'
import { errorSchema } from '../lib/openapi-schemas'
import { assertWorkspaceWriterRole } from '../lib/workspace-auth'
import { transcribeAudio } from '../services/transcription'

type Env = {
	Variables: {
		actorId: string
		workspaceRole?: string
	}
}

// The client caps a recording at 3 minutes of 16 kHz mono 16-bit WAV (~5.8 MB,
// ~7.7 MB as base64). The limits leave headroom for that and nothing more.
export const MAX_AUDIO_BASE64_CHARS = 10_000_000
const MAX_BODY_BYTES = MAX_AUDIO_BASE64_CHARS + 4_096

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

app.use(
	'/',
	bodyLimit({
		maxSize: MAX_BODY_BYTES,
		onError: (c) => c.json(createApiError('BAD_REQUEST', 'Audio is too large'), 413),
	}),
)

const transcribeBody = z
	.object({
		audio: z.string().min(1).max(MAX_AUDIO_BASE64_CHARS).openapi({
			description: 'Base64 of a WAV file (16 kHz mono recommended).',
		}),
		language: z
			.string()
			.regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/)
			.optional()
			.openapi({ description: 'Optional language hint, e.g. "en" or "nb-NO".' }),
	})
	.openapi('TranscribeBody')

const transcribeResponse = z.object({ text: z.string() }).openapi('TranscribeResponse')

const postTranscriptionRoute = createRoute({
	method: 'post',
	path: '/',
	'x-viewer-policy': 'writer',
	tags: ['Transcriptions'],
	summary: 'Transcribe a short voice recording (chat dictation)',
	description:
		'Sends the audio to a speech-to-text model on OpenRouter (default Voxtral Small, override with MASKIN_TRANSCRIPTION_MODEL) and returns the text. Requires X-Workspace-Id; the call is billed to the operator account, so a read-only viewer is refused.',
	request: {
		body: { content: { 'application/json': { schema: transcribeBody } }, required: true },
	},
	responses: {
		200: {
			description: 'Transcript; empty text when no speech was detected',
			content: { 'application/json': { schema: transcribeResponse } },
		},
		400: {
			description: 'Missing X-Workspace-Id or invalid body',
			content: { 'application/json': { schema: errorSchema } },
		},
		413: {
			description: 'Audio too large',
			content: { 'application/json': { schema: errorSchema } },
		},
		429: {
			description: 'The speech provider is rate limiting us',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Transcription is not configured on this server',
			content: { 'application/json': { schema: errorSchema } },
		},
		502: {
			description: 'The speech provider failed',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(postTranscriptionRoute, async (c) => {
	const role = c.get('workspaceRole')
	if (role === undefined) {
		return c.json(createApiError('BAD_REQUEST', 'X-Workspace-Id header is required'), 400)
	}
	assertWorkspaceWriterRole(role)

	const { audio, language } = c.req.valid('json')
	const result = await transcribeAudio({ audioBase64: audio, language })

	if (result.ok) return c.json({ text: result.text }, 200)
	if (result.reason === 'not_configured') {
		return c.json(createApiError('INTERNAL_ERROR', 'Transcription is not configured'), 500)
	}
	if (result.status === 429) {
		return c.json(createApiError('RATE_LIMITED', 'Transcription is busy, try again shortly'), 429)
	}
	return c.json(createApiError('INTERNAL_ERROR', 'Transcription failed'), 502)
})

export default app
