import type { Database } from '@ai-native/db'
import { events, objects, relationships } from '@ai-native/db/schema'
import type { ModuleEnv } from '@ai-native/module-sdk'
import { OpenAPIHono } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import { transcribe } from '../services/transcription.js'

type HonoEnv = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const ACCEPTED_FORMATS = ['wav', 'mp3', 'm4a', 'webm']
const MAX_FILE_SIZE = 500 * 1024 * 1024 // 500 MB

function getExtension(filename: string): string {
	return filename.split('.').pop()?.toLowerCase() ?? ''
}

function serializeObject(obj: Record<string, unknown>) {
	const result: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(obj)) {
		result[key] = value instanceof Date ? value.toISOString() : value
	}
	return result
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

		// Parse multipart form data
		const formData = await c.req.formData()
		const file = formData.get('file')
		const title = formData.get('title') as string | null
		const language = formData.get('language') as string | null
		const linkedObjectId = formData.get('linkedObjectId') as string | null

		if (!file || !(file instanceof File)) {
			return c.json({ error: 'Missing required field: file' }, 400)
		}

		// Validate format
		const ext = getExtension(file.name)
		if (!ACCEPTED_FORMATS.includes(ext)) {
			return c.json(
				{
					error: `Unsupported format: .${ext}. Accepted: ${ACCEPTED_FORMATS.map((f) => `.${f}`).join(', ')}`,
				},
				400,
			)
		}

		// Validate size
		if (file.size > MAX_FILE_SIZE) {
			return c.json(
				{ error: `File too large. Maximum size: ${MAX_FILE_SIZE / 1024 / 1024}MB` },
				400,
			)
		}

		// Create meeting object with initial status
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
			// Store audio in S3
			const audioBuffer = Buffer.from(await file.arrayBuffer())
			const s3Key = `notetaker/${workspaceId}/${meeting.id}/${file.name}`
			await env.storageProvider.put(s3Key, audioBuffer)

			// Transcribe
			const result = await transcribe(audioBuffer, file.name, language ? { language } : undefined)

			// Update meeting object with transcription
			const [updated] = await db
				.update(objects)
				.set({
					content: result.text,
					status: 'completed',
					metadata: {
						source: 'upload',
						original_filename: file.name,
						language: result.language,
						audio_s3_key: s3Key,
						segments: result.segments,
					},
					updatedAt: new Date(),
				})
				.where(eq(objects.id, meeting.id))
				.returning()

			// Log event
			await db.insert(events).values({
				workspaceId,
				actorId,
				action: 'created',
				entityType: 'meeting',
				entityId: meeting.id,
				data: updated,
			})

			// Create relationship if linkedObjectId provided
			if (linkedObjectId) {
				await db
					.insert(relationships)
					.values({
						sourceType: 'meeting',
						sourceId: meeting.id,
						targetType: 'unknown',
						targetId: linkedObjectId,
						type: 'relates_to',
						createdBy: actorId,
					})
					.onConflictDoNothing()
			}

			return c.json(serializeObject(updated as Record<string, unknown>), 201)
		} catch (err) {
			// Mark as failed on error
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

			return c.json(
				{ error: `Transcription failed: ${err instanceof Error ? err.message : 'Unknown error'}` },
				500,
			)
		}
	})

	return app
}
