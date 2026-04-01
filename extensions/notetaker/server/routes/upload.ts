import { events, objects, relationships } from '@ai-native/db/schema'
import type { ModuleEnv } from '@ai-native/module-sdk'
import { OpenAPIHono } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import { transcribe } from '../services/transcription.js'

type HonoEnv = {
	Variables: {
		actorId: string
		actorType: string
	}
}

const ACCEPTED_FORMATS = ['wav', 'mp3', 'm4a', 'webm']
const MAX_FILE_SIZE = 500 * 1024 * 1024 // 500 MB

function getExtension(filename: string): string {
	return filename.split('.').pop()?.toLowerCase() ?? ''
}

export function createUploadRoutes(env: ModuleEnv) {
	const app = new OpenAPIHono<HonoEnv>()

	app.post('/upload', async (c) => {
		const db = env.db
		const actorId = c.get('actorId')
		const workspaceId = c.req.header('X-Workspace-Id')

		if (!workspaceId) {
			return c.json({ error: 'Missing X-Workspace-Id header' }, 400)
		}

		const formData = await c.req.formData()
		const file = formData.get('file')
		const title = formData.get('title') as string | null
		const language = formData.get('language') as string | null
		const linkedObjectId = formData.get('linkedObjectId') as string | null

		if (!file || !(file instanceof File)) {
			return c.json({ error: 'Missing required field: file' }, 400)
		}

		const ext = getExtension(file.name)
		if (!ACCEPTED_FORMATS.includes(ext)) {
			return c.json(
				{
					error: `Unsupported format: .${ext}. Accepted: ${ACCEPTED_FORMATS.map((f) => `.${f}`).join(', ')}`,
				},
				400,
			)
		}

		if (file.size > MAX_FILE_SIZE) {
			return c.json(
				{ error: `File too large. Maximum size: ${MAX_FILE_SIZE / 1024 / 1024}MB` },
				400,
			)
		}

		const [meeting] = await db
			.insert(objects)
			.values({
				workspaceId,
				type: 'meeting',
				title: title || file.name,
				status: 'transcribing',
				metadata: {
					source: 'upload',
					original_filename: file.name,
				},
				createdBy: actorId,
			})
			.returning()

		if (!meeting) {
			return c.json({ error: 'Failed to create meeting object' }, 500)
		}

		try {
			const audioBuffer = Buffer.from(await file.arrayBuffer())
			const s3Key = `notetaker/${workspaceId}/${meeting.id}/${file.name}`

			// S3 upload and transcription are independent — run in parallel
			const [, result] = await Promise.all([
				env.storageProvider.put(s3Key, audioBuffer),
				transcribe(audioBuffer, file.name, language ? { language } : undefined),
			])

			// Store transcript and segments in S3
			const transcriptS3Key = `notetaker/${workspaceId}/${meeting.id}/transcript.txt`
			const segmentsS3Key = `notetaker/${workspaceId}/${meeting.id}/segments.json`
			await Promise.all([
				env.storageProvider.put(transcriptS3Key, Buffer.from(result.text, 'utf-8')),
				env.storageProvider.put(
					segmentsS3Key,
					Buffer.from(JSON.stringify(result.segments), 'utf-8'),
				),
			])

			// Calculate duration from segments if available
			const lastSegment = result.segments.at(-1)
			const durationSeconds = lastSegment ? Math.ceil(lastSegment.end) : null

			// Store proxy URLs that route through our files endpoint (no expiry)
			const publicBase = process.env.WEBHOOK_BASE_URL?.replace(/\/$/, '') || ''
			const filesBase = `${publicBase}/api/m/notetaker/files`

			const [updated] = await db
				.update(objects)
				.set({
					content: result.text,
					status: 'completed',
					metadata: {
						source: 'upload',
						original_filename: file.name,
						language: result.language,
						audio_url: `${filesBase}/${s3Key}`,
						transcript_url: `${filesBase}/${transcriptS3Key}`,
						segments_url: `${filesBase}/${segmentsS3Key}`,
						duration_seconds: durationSeconds,
					},
					updatedAt: new Date(),
				})
				.where(eq(objects.id, meeting.id))
				.returning()

			await db.insert(events).values({
				workspaceId,
				actorId,
				action: 'created',
				entityType: 'meeting',
				entityId: meeting.id,
				data: updated,
			})

			if (linkedObjectId) {
				const [linkedObj] = await db
					.select({ type: objects.type })
					.from(objects)
					.where(eq(objects.id, linkedObjectId))

				if (linkedObj) {
					await db
						.insert(relationships)
						.values({
							sourceType: 'meeting',
							sourceId: meeting.id,
							targetType: linkedObj.type,
							targetId: linkedObjectId,
							type: 'relates_to',
							createdBy: actorId,
						})
						.onConflictDoNothing()
				}
			}

			return c.json(updated, 201)
		} catch (err) {
			try {
				await db
					.update(objects)
					.set({
						status: 'failed',
						metadata: {
							source: 'upload',
							original_filename: file.name,
							error: err instanceof Error ? err.message : 'Unknown error',
						},
						updatedAt: new Date(),
					})
					.where(eq(objects.id, meeting.id))
			} catch (updateErr) {
				console.error('Failed to mark meeting as failed', {
					meetingId: meeting.id,
					updateErr,
				})
			}

			return c.json(
				{ error: `Transcription failed: ${err instanceof Error ? err.message : 'Unknown error'}` },
				500,
			)
		}
	})

	return app
}
