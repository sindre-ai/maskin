import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { files, workspaces } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { bodyLimit } from 'hono/body-limit'
import { isEnterprise } from '../lib/enterprise'
import { createApiError, validationFailureHook } from '../lib/errors'
import { checkPlanCap } from '../lib/llm-routing'
import { errorSchema, idParamSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import type { WorkspaceSettings } from '../lib/types'
import { assertWorkspaceWriterRole } from '../lib/workspace-auth'
import {
	FileTranscriptionError,
	type FileTranscriptionFailure,
	MAX_TRANSCRIBE_AUDIO_SECONDS,
	transcribeStoredFile,
} from '../services/file-transcription'
import { saveTranscriptFile } from '../services/transcript-file'
import { transcribeAudio } from '../services/transcription'

type Env = {
	Variables: {
		db: Database
		actorId: string
		workspaceRole?: string
		maskinSessionId?: string
		storageProvider: StorageProvider
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
		'Sends the audio to a speech-to-text model on OpenRouter (default Voxtral Small, override with MASKIN_TRANSCRIPTION_MODEL) and returns the text. Requires X-Workspace-Id; the call is billed to the operator account, so a read-only viewer is refused. Upstream failures are told apart: 429 busy, 503 provider account or key refused (401/402), 504 timeout or no answer, 502 any other provider error.',
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
			description: 'The speech provider answered with an error other than 401, 402 or 429',
			content: { 'application/json': { schema: errorSchema } },
		},
		503: {
			description:
				'The speech provider refused our key or account (401 or 402): transcription is not available on this server until the operator fixes it. Retrying will not help.',
			content: { 'application/json': { schema: errorSchema } },
		},
		504: {
			description: 'The request to the speech provider timed out or could not be made',
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
	if (result.reason === 'exception') {
		return c.json(createApiError('INTERNAL_ERROR', 'Transcription timed out, try again'), 504)
	}
	if (result.status === 429) {
		return c.json(createApiError('RATE_LIMITED', 'Transcription is busy, try again shortly'), 429)
	}
	if (result.status === 401 || result.status === 402) {
		return c.json(
			createApiError(
				'INTERNAL_ERROR',
				'Transcription is not available on this server (speech provider account or key problem)',
			),
			503,
		)
	}
	return c.json(
		createApiError('INTERNAL_ERROR', 'Transcription failed (speech provider error)'),
		502,
	)
})

// -- POST /files/:id — transcribe an uploaded audio or video file -----------------

const FILE_FAILURE_STATUS: Record<FileTranscriptionFailure, 400 | 429 | 500 | 502 | 503 | 504> = {
	not_transcribable: 400,
	too_long: 400,
	tooling_unavailable: 503,
	not_configured: 500,
	busy: 429,
	provider_refused: 503,
	provider_error: 502,
	timeout: 504,
	storage_error: 500,
}

/** What a stored file may be before we spend a download on it; ffprobe decides the rest. */
const MEDIA_MIME_PREFIXES = ['audio/', 'video/']
const MEDIA_MIME_EXACT = new Set([
	'application/ogg',
	'application/mp4',
	'application/x-matroska',
	'application/octet-stream',
])

function isTranscribableMime(mimeType: string): boolean {
	const mime = mimeType.toLowerCase()
	return MEDIA_MIME_PREFIXES.some((p) => mime.startsWith(p)) || MEDIA_MIME_EXACT.has(mime)
}

const transcribeFileBody = z
	.object({
		language: z
			.string()
			.regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/)
			.optional()
			.openapi({ description: 'Optional language hint, e.g. "en" or "nb-NO".' }),
	})
	.openapi('TranscribeFileBody')

const transcribeFileResponse = z
	.object({
		file_id: z.string().uuid(),
		name: z.string(),
		transcript_file_id: z.string().uuid().nullable().openapi({
			description:
				'The saved .txt transcript. Read it with get_file. Null when no speech was found, or when saving it failed (then `text` holds the transcript).',
		}),
		transcript_file_url: z.string().nullable(),
		text: z.string().nullable().openapi({
			description:
				'Null when the transcript was saved: read the file. Set only when saving failed (the whole transcript) or no speech was found (empty).',
		}),
		next_step: z.string().openapi({ description: 'What to do with this result.' }),
		timed: z.boolean().openapi({
			description:
				'True when the transcript has timestamps and speaker labels; false when the model returned plain text only.',
		}),
		audio_seconds: z.number(),
		chunks: z.number().int(),
		model: z.string(),
	})
	.openapi('TranscribeFileResponse')

const postFileTranscriptionRoute = createRoute({
	method: 'post',
	path: '/files/{id}',
	'x-viewer-policy': 'writer',
	tags: ['Transcriptions'],
	summary: 'Transcribe an uploaded audio or video file',
	description: `Reads a stored file, extracts its audio with ffmpeg, transcribes it in chunks on OpenRouter and saves the transcript as a .txt workspace file. The response carries the file's id, not the text: read it with get_file. Up to ${MAX_TRANSCRIBE_AUDIO_SECONDS / 60} minutes of audio. The cost OpenRouter reports is recorded against the workspace's plan usage, so the call is refused with 402 once the plan cap is reached and no prepaid credit remains. An enterprise workspace is never capped, but its usage is still recorded. Requires X-Workspace-Id and a writer role.`,
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: { content: { 'application/json': { schema: transcribeFileBody } }, required: true },
	},
	responses: {
		200: {
			description: 'Transcript; empty text when no speech was detected',
			content: { 'application/json': { schema: transcribeFileResponse } },
		},
		400: {
			description: 'Not audio or video, no audio track, or longer than the limit',
			content: { 'application/json': { schema: errorSchema } },
		},
		402: {
			description: 'The workspace is over its plan cap',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'The caller has a read-only role in this workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'File not found in this workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		429: {
			description: 'The speech provider is rate limiting us',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Transcription is not configured, or the file could not be read from storage',
			content: { 'application/json': { schema: errorSchema } },
		},
		502: {
			description: 'The speech provider answered with an error other than 401, 402 or 429',
			content: { 'application/json': { schema: errorSchema } },
		},
		503: {
			description: 'The speech provider refused our key, or ffmpeg is not installed on this server',
			content: { 'application/json': { schema: errorSchema } },
		},
		504: {
			description: 'The request to the speech provider timed out',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(postFileTranscriptionRoute, async (c) => {
	const role = c.get('workspaceRole')
	const workspaceId = c.req.header('X-Workspace-Id')
	if (role === undefined || !workspaceId) {
		return c.json(createApiError('BAD_REQUEST', 'X-Workspace-Id header is required'), 400)
	}
	assertWorkspaceWriterRole(role)

	const db = c.get('db')
	const { id } = c.req.valid('param')
	const { language } = c.req.valid('json')

	// The workspace comes from the header, which authMiddleware proved the caller
	// belongs to, and the file must be in it: another workspace's file is a 404.
	const [file] = await db
		.select({
			id: files.id,
			name: files.name,
			mimeType: files.mimeType,
			storageKey: files.storageKey,
		})
		.from(files)
		.where(and(eq(files.id, id), eq(files.workspaceId, workspaceId)))
		.limit(1)
	if (!file) return c.json(createApiError('NOT_FOUND', 'File not found'), 404)
	if (!isTranscribableMime(file.mimeType)) {
		return c.json(
			createApiError(
				'VALIDATION_ERROR',
				`This file is ${file.mimeType}, not audio or video, so it cannot be transcribed.`,
			),
			400,
		)
	}

	const [workspace] = await db
		.select({
			settings: workspaces.settings,
			enterpriseGranted: workspaces.enterpriseGranted,
			billingOwnerId: workspaces.billingOwnerId,
		})
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!workspace) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)

	// Transcription runs on Maskin's OpenRouter account. An enterprise workspace is
	// exempt from the plan cap (checkPlanCap returns early) but its spend is recorded.
	const enterprise = isEnterprise(workspace)
	// Throws PlanCapExceededError, which the app's error handler turns into a 402.
	await checkPlanCap({
		db,
		workspaceId,
		wsSettings: (workspace.settings ?? {}) as WorkspaceSettings,
		enterprise,
	})

	try {
		const result = await transcribeStoredFile({
			db,
			storage: c.get('storageProvider'),
			workspaceId,
			actorId: c.get('actorId'),
			file: { id: file.id, storageKey: file.storageKey },
			language,
		})
		// Always kept as a file, never returned inline. Two exceptions: no speech means
		// nothing worth a file, and if saving fails the audio is already paid for, so
		// the text goes back inline instead.
		const saved =
			result.text === ''
				? null
				: await saveTranscriptFile({
						db,
						storage: c.get('storageProvider'),
						workspaceId,
						actorId: c.get('actorId'),
						sessionId: c.get('maskinSessionId'),
						sourceName: file.name,
						text: result.text,
					})
		return c.json(
			{
				file_id: file.id,
				name: file.name,
				transcript_file_id: saved?.fileId ?? null,
				transcript_file_url: saved?.url ?? null,
				text: saved ? null : result.text,
				next_step: saved
					? `The transcript is saved as a file. Read it with get_file on id ${saved.fileId}.`
					: result.text === ''
						? 'No speech was found in this recording, so no transcript file was saved.'
						: 'The transcript could not be saved as a file, so the whole text is in `text`.',
				timed: result.timed,
				audio_seconds: Math.round(result.audioSeconds * 100) / 100,
				chunks: result.chunks,
				model: result.model,
			},
			200,
		)
	} catch (err) {
		if (err instanceof FileTranscriptionError) {
			const status = FILE_FAILURE_STATUS[err.code]
			const code =
				status === 400 ? 'VALIDATION_ERROR' : status === 429 ? 'RATE_LIMITED' : 'INTERNAL_ERROR'
			return c.json(createApiError(code, err.message), status)
		}
		throw err
	}
})

export default app
