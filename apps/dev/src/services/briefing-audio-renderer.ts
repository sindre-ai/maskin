import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import { events, files, objects, relationships } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { logger } from '../lib/logger'

/**
 * The trigger runner dispatches `render_briefing_audio` in-process instead of
 * spawning an agent session — TTS is a straight API call, no reasoning needed,
 * and keeping it out of a container avoids ~10s of cold-start on every daily
 * briefing.
 */
export const BRIEFING_AUDIO_HANDLER = 'render_briefing_audio' as const

/**
 * Attachment type used to link a briefing object to its rendered MP3. Reuses
 * the existing `attached` relationship type (source/target constrained to
 * ('object', 'file') by the schema check) rather than inventing a new one.
 */
export const BRIEFING_AUDIO_RELATIONSHIP_TYPE = 'attached' as const

export const BRIEFING_AUDIO_MIME_TYPE = 'audio/mpeg' as const
export const BRIEFING_AUDIO_FILE_NAME = 'briefing.mp3' as const

const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts'
const OPENAI_TTS_VOICE = 'alloy'
const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech'

// Matches packages/shared/src/schemas/files.ts.
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024

// Hard cap on the text handed to TTS — the daily briefing markdown Sebk reads
// today runs 3–5 KB, and OpenAI's own limit for a single request is 4096
// characters. Anything larger gets truncated with an explicit log so we never
// silently drop content mid-word.
const MAX_TTS_INPUT_CHARS = 4096

export function briefingAudioStorageKey(workspaceId: string, briefingId: string): string {
	return `workspaces/${workspaceId}/briefings/${briefingId}/audio.mp3`
}

export type TtsFetcher = (input: { apiKey: string; text: string }) => Promise<Buffer>

async function defaultTtsFetcher({
	apiKey,
	text,
}: { apiKey: string; text: string }): Promise<Buffer> {
	const response = await fetch(OPENAI_TTS_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: OPENAI_TTS_MODEL,
			voice: OPENAI_TTS_VOICE,
			input: text,
			response_format: 'mp3',
		}),
	})
	if (!response.ok) {
		const errText = await response.text().catch(() => '')
		throw new Error(`OpenAI TTS request failed: ${response.status} ${errText}`.trim())
	}
	const bytes = await response.arrayBuffer()
	return Buffer.from(bytes)
}

export interface BriefingAudioRenderDeps {
	db: Database
	storage: StorageProvider
	getApiKey?: () => string | undefined
	fetchTts?: TtsFetcher
}

export interface BriefingAudioRenderInput {
	workspaceId: string
	briefingId: string
	actorId: string
}

export type BriefingAudioRenderResult =
	| { status: 'rendered'; fileId: string; sizeBytes: number }
	| { status: 'already_attached'; fileId: string }
	| { status: 'skipped'; reason: 'briefing_not_found' | 'empty_content' }

/**
 * Render the audio track for a briefing knowledge object: fetch TTS from
 * OpenAI, upload the MP3 to S3, and attach it to the briefing via a
 * `relationships` row. Idempotent per briefing — a briefing that already has
 * an `attached` file relationship short-circuits with `already_attached`.
 *
 * The renderer intentionally throws on `OPENAI_API_KEY` missing so the trigger
 * runner's existing backoff surfaces the misconfig via `recordTriggerFailure`
 * instead of silently skipping every briefing.
 */
export async function renderBriefingAudio(
	deps: BriefingAudioRenderDeps,
	input: BriefingAudioRenderInput,
): Promise<BriefingAudioRenderResult> {
	const { db, storage } = deps
	const { workspaceId, briefingId, actorId } = input
	const getApiKey = deps.getApiKey ?? (() => process.env.OPENAI_API_KEY)
	const fetchTts = deps.fetchTts ?? defaultTtsFetcher

	// 1. Exactly-once: bail before hitting OpenAI if this briefing already has
	// an attached file. Runs first so a retry after a partial commit is a no-op
	// instead of another paid render.
	const existing = await db
		.select({ targetId: relationships.targetId })
		.from(relationships)
		.where(
			and(
				eq(relationships.sourceType, 'object'),
				eq(relationships.sourceId, briefingId),
				eq(relationships.targetType, 'file'),
				eq(relationships.type, BRIEFING_AUDIO_RELATIONSHIP_TYPE),
			),
		)
		.limit(1)
	if (existing.length > 0 && existing[0]?.targetId) {
		logger.info('Briefing audio already attached — skipping render', {
			workspaceId,
			briefingId,
			fileId: existing[0].targetId,
		})
		return { status: 'already_attached', fileId: existing[0].targetId }
	}

	// 2. Load the briefing text. Missing row → skip; a trigger fired ahead of
	// the object commit shouldn't crash the runner.
	const [briefing] = await db
		.select({ content: objects.content, workspaceId: objects.workspaceId })
		.from(objects)
		.where(eq(objects.id, briefingId))
		.limit(1)
	if (!briefing) {
		logger.warn('Briefing object not found for audio render', { workspaceId, briefingId })
		return { status: 'skipped', reason: 'briefing_not_found' }
	}
	const rawText = (briefing.content ?? '').trim()
	if (!rawText) {
		logger.warn('Briefing has empty content — nothing to render', { workspaceId, briefingId })
		return { status: 'skipped', reason: 'empty_content' }
	}
	let text = rawText
	if (rawText.length > MAX_TTS_INPUT_CHARS) {
		logger.warn('Briefing content exceeds TTS input cap — truncating', {
			workspaceId,
			briefingId,
			originalChars: rawText.length,
			cap: MAX_TTS_INPUT_CHARS,
		})
		text = rawText.slice(0, MAX_TTS_INPUT_CHARS)
	}

	// 3. Env check. Throw so the trigger runner records a failure + backoff
	// rather than skipping the render silently. The DoD explicitly calls this
	// out — a missing key must not look like a normal quiet pass.
	const apiKey = getApiKey()
	if (!apiKey) {
		throw new Error('OPENAI_API_KEY is not set — cannot render briefing audio')
	}

	// 4. TTS → MP3 bytes.
	const mp3 = await fetchTts({ apiKey, text })
	if (mp3.byteLength === 0) {
		throw new Error('OpenAI TTS returned empty audio')
	}
	if (mp3.byteLength > MAX_FILE_SIZE_BYTES) {
		throw new Error(
			`Rendered briefing audio (${mp3.byteLength}B) exceeds file cap (${MAX_FILE_SIZE_BYTES}B)`,
		)
	}

	// 5. Upload to S3 before inserting the row. Same order as
	// routes/files.ts uses in reverse (row first, then put) is safe there
	// because the ID is minted client-side; here we mint the id too but keep
	// the DB write behind the S3 put so a failed upload doesn't leave a
	// half-attached row for the frontend to hit.
	const fileId = randomUUID()
	const storageKey = briefingAudioStorageKey(workspaceId, briefingId)
	await storage.put(storageKey, mp3)

	// 6. Insert file row + attachment relationship + audit event. If either
	// insert races another concurrent render, the relationships uniqueness
	// constraint (source_id, target_id, type) will still allow the second
	// attachment because target_ids differ — but the exactly-once check at
	// step 1 guards against the wasted TTS spend in that path. Cleanup on
	// insert failure removes the orphan S3 object.
	try {
		await db.insert(files).values({
			id: fileId,
			workspaceId,
			name: BRIEFING_AUDIO_FILE_NAME,
			description: 'Auto-rendered briefing audio',
			mimeType: BRIEFING_AUDIO_MIME_TYPE,
			sizeBytes: mp3.byteLength,
			storageKey,
			createdBy: actorId,
		})

		await db.insert(relationships).values({
			sourceType: 'object',
			sourceId: briefingId,
			targetType: 'file',
			targetId: fileId,
			type: BRIEFING_AUDIO_RELATIONSHIP_TYPE,
			createdBy: actorId,
		})

		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'created',
			entityType: 'file',
			entityId: fileId,
			data: {
				id: fileId,
				name: BRIEFING_AUDIO_FILE_NAME,
				mimeType: BRIEFING_AUDIO_MIME_TYPE,
				sizeBytes: mp3.byteLength,
				attachedToBriefingId: briefingId,
			},
		})
	} catch (err) {
		logger.error('Failed to persist briefing audio row — deleting orphan S3 object', {
			workspaceId,
			briefingId,
			storageKey,
			error: String(err),
		})
		try {
			await storage.delete(storageKey)
		} catch (cleanupErr) {
			logger.error('Failed to delete orphan briefing audio S3 object', {
				storageKey,
				error: String(cleanupErr),
			})
		}
		throw err
	}

	logger.info('Rendered briefing audio', {
		workspaceId,
		briefingId,
		fileId,
		sizeBytes: mp3.byteLength,
	})
	return { status: 'rendered', fileId, sizeBytes: mp3.byteLength }
}
