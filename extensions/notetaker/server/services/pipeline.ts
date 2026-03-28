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
		const [, result] = await Promise.all([
			env.storageProvider.put(s3Key, audioBuffer),
			transcribe(audioBuffer, filename),
		])

		// Update meeting object with transcription
		const [updated] = await db
			.update(objects)
			.set({
				content: result.text,
				status: 'completed',
				metadata: {
					source: 'recall',
					bot_id: botId,
					language: result.language,
					audio_s3_key: s3Key,
					segments: result.segments,
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
		// Mark as failed
		await db
			.update(objects)
			.set({
				status: 'failed',
				metadata: {
					source: 'recall',
					bot_id: botId,
					error: err instanceof Error ? err.message : 'Unknown error',
				},
				updatedAt: new Date(),
			})
			.where(eq(objects.id, meetingId))

		throw err
	}
}
