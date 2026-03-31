import { events, objects } from '@ai-native/db/schema'
import type { ModuleEnv } from '@ai-native/module-sdk'
import { eq } from 'drizzle-orm'
import { downloadRecording, getBot } from './recall.js'
import { transcribe } from './transcription.js'

/**
 * Process a completed recording from Recall.ai:
 * 1. Fetch bot details to get video_url
 * 2. Download the recording
 * 3. Store audio in S3
 * 4. Transcribe via whisper.cpp
 * 5. Update the meeting object with transcript
 */
export async function processRecording(
	meetingId: string,
	botId: string,
	workspaceId: string,
	actorId: string,
	env: ModuleEnv,
	options?: { language?: string },
): Promise<void> {
	const db = env.db

	// Update status to transcribing
	await db
		.update(objects)
		.set({ status: 'transcribing', updatedAt: new Date() })
		.where(eq(objects.id, meetingId))

	try {
		// Fetch bot to get recording URL
		const bot = await getBot(botId)
		if (!bot.video_url) {
			throw new Error(`Bot ${botId} has no video_url`)
		}

		// Download recording
		const audioBuffer = await downloadRecording(bot.video_url)
		const filename = `recording-${botId}.mp4`
		const s3Key = `notetaker/${workspaceId}/${meetingId}/${filename}`

		// Store in S3 and transcribe in parallel
		const language = options?.language || undefined
		const [, result] = await Promise.all([
			env.storageProvider.put(s3Key, audioBuffer),
			transcribe(audioBuffer, filename, { language }),
		])

		// Store transcript and segments in S3
		const transcriptS3Key = `notetaker/${workspaceId}/${meetingId}/transcript.txt`
		const segmentsS3Key = `notetaker/${workspaceId}/${meetingId}/segments.json`
		await Promise.all([
			env.storageProvider.put(transcriptS3Key, Buffer.from(result.text, 'utf-8')),
			env.storageProvider.put(segmentsS3Key, Buffer.from(JSON.stringify(result.segments), 'utf-8')),
		])

		// Calculate duration from segments if available
		const lastSegment = result.segments.at(-1)
		const durationSeconds = lastSegment ? Math.ceil(lastSegment.end) : null

		// Preserve existing user-facing metadata and add transcription data
		const [existingObj] = await db
			.select({ metadata: objects.metadata })
			.from(objects)
			.where(eq(objects.id, meetingId))
			.limit(1)

		const existingMetadata = (existingObj?.metadata as Record<string, unknown>) ?? {}

		// Update meeting object with transcription — keep user-facing fields, add results
		const [updated] = await db
			.update(objects)
			.set({
				content: result.text,
				status: 'completed',
				metadata: {
					...existingMetadata,
					language: result.language,
					audio_s3_key: s3Key,
					transcript_s3_key: transcriptS3Key,
					segments_s3_key: segmentsS3Key,
					duration_seconds: durationSeconds,
				},
				updatedAt: new Date(),
			})
			.where(eq(objects.id, meetingId))
			.returning()

		// Log event
		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'updated',
			entityType: 'meeting',
			entityId: meetingId,
			data: updated,
		})
	} catch (err) {
		// Preserve existing metadata on failure
		const [existingObj] = await db
			.select({ metadata: objects.metadata })
			.from(objects)
			.where(eq(objects.id, meetingId))
			.limit(1)

		const existingMetadata = (existingObj?.metadata as Record<string, unknown>) ?? {}

		// Mark as failed
		await db
			.update(objects)
			.set({
				status: 'failed',
				metadata: {
					...existingMetadata,
					error: err instanceof Error ? err.message : 'Unknown error',
				},
				updatedAt: new Date(),
			})
			.where(eq(objects.id, meetingId))

		throw err
	}
}
