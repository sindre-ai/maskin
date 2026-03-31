import type { Database } from '@ai-native/db'
import type { ModuleEnv } from '@ai-native/module-sdk'
import { OpenAPIHono } from '@hono/zod-openapi'

type HonoEnv = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const CONTENT_TYPES: Record<string, string> = {
	'.mp4': 'video/mp4',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.webm': 'audio/webm',
	'.txt': 'text/plain; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
}

function getContentType(key: string): string {
	const ext = key.slice(key.lastIndexOf('.')).toLowerCase()
	return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

/**
 * GET /api/m/notetaker/files/*
 *
 * Serves files from S3 storage. Used for audio recordings, transcripts, and segments.
 */
export function createFileRoutes(env: ModuleEnv) {
	const app = new OpenAPIHono<HonoEnv>()

	app.get('/files/*', async (c) => {
		const path = c.req.path
		// Extract the S3 key from the path (everything after /files/)
		const prefix = '/api/m/notetaker/files/'
		const keyStart = path.indexOf(prefix)
		if (keyStart === -1) {
			return c.json({ error: 'Invalid file path' }, 400)
		}
		const key = decodeURIComponent(path.slice(keyStart + prefix.length))

		if (!key || key.includes('..')) {
			return c.json({ error: 'Invalid file path' }, 400)
		}

		// Only allow access to notetaker files
		if (!key.startsWith('notetaker/')) {
			return c.json({ error: 'Access denied' }, 403)
		}

		try {
			const exists = await env.storageProvider.exists(key)
			if (!exists) {
				return c.json({ error: 'File not found' }, 404)
			}

			const data = await env.storageProvider.get(key)
			const contentType = getContentType(key)
			const filename = key.split('/').pop() ?? 'download'

			return new Response(new Uint8Array(data), {
				headers: {
					'Content-Type': contentType,
					'Content-Disposition': `inline; filename="${filename}"`,
					'Content-Length': String(data.length),
					'Cache-Control': 'private, max-age=3600',
				},
			})
		} catch {
			return c.json({ error: 'Failed to retrieve file' }, 500)
		}
	})

	return app
}
