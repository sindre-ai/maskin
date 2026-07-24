import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { OpenAPIHono } from '@hono/zod-openapi'
import { files } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const { default: filesRoutes } = await import('../../routes/files')

// AC-T4: aborting an in-flight POST /files request must leave no orphan row
// in the files table. The chat composer cancels in-flight uploads via the
// same AbortController pattern the comment input uses; this asserts the
// server side of that contract — if the body never finishes streaming, the
// route handler never inserts.
describe('Files abort (integration)', () => {
	let workspaceId: string
	let server: ReturnType<typeof serve>
	let baseUrl: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id

		// Minimal in-memory storage stub. The successful path would call
		// storage.put after the DB insert; we never expect to reach it here
		// because the abort interrupts body parsing first.
		const storageProvider = {
			put: async () => undefined,
			get: async () => Buffer.from(''),
			list: async () => [],
			delete: async () => undefined,
			exists: async () => false,
			ensureBucket: async () => undefined,
		} as unknown as StorageProvider

		const app = new OpenAPIHono({
			defaultHook: (result, c) => {
				if (!result.success) {
					return c.json(
						createApiError(
							'VALIDATION_ERROR',
							'Request validation failed',
							formatZodError(result.error),
						),
						400,
					)
				}
				return undefined
			},
		})
		app.use('*', async (c, next) => {
			c.set('db', db)
			c.set('actorId', getTestActorId())
			c.set('actorType', 'human')
			c.set('notifyBridge', {} as PgNotifyBridge)
			c.set('storageProvider', storageProvider)
			await next()
		})
		app.route('/api/files', filesRoutes)

		server = serve({ fetch: app.fetch, port: 0 })
		// Resolve once the listener has bound a port.
		await new Promise<void>((resolve) => {
			server.on('listening', () => resolve())
			// Already listening when serve returns synchronously in newer
			// versions of @hono/node-server — guard against missing the event.
			if (server.listening) resolve()
		})
		const addr = server.address() as AddressInfo
		baseUrl = `http://127.0.0.1:${addr.port}`
	})

	afterEach(async () => {
		await new Promise<void>((resolve, reject) =>
			server.close((err) => (err ? reject(err) : resolve())),
		)
	})

	it('does not insert a files row when the upload is aborted mid-stream', async () => {
		// 2MB raw → ~2.7MB base64. Big enough that the body cannot land in a
		// single tick, so the abort interrupts body reading on the server.
		const bigPayload = Buffer.alloc(2 * 1024 * 1024).toString('base64')
		const body = JSON.stringify({
			name: 'big.png',
			mime_type: 'image/png',
			content: bigPayload,
			encoding: 'base64',
		})

		const controller = new AbortController()
		const promise = fetch(`${baseUrl}/api/files`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Workspace-Id': workspaceId,
			},
			body,
			signal: controller.signal,
		})
		// Abort on the next tick so the fetch begins streaming before we cancel.
		queueMicrotask(() => controller.abort())

		await expect(promise).rejects.toThrow()

		// Give the server a beat to settle any in-flight write that lost the
		// race — if a row had been inserted we'd see it here.
		await new Promise((r) => setTimeout(r, 100))

		const rows = await db.select().from(files).where(eq(files.workspaceId, workspaceId))
		expect(rows).toHaveLength(0)
	})
})
