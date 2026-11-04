import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { type AppDeps, createApp } from '../app-factory'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'

/**
 * An <img> tag cannot send an API key, so GET /api/actors/:uuid/avatar skips
 * authentication. The exemption must stay exactly that wide: one GET path, answered
 * only for the current ?v= (checked in the handler), and every write still needs a key.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])

function buildApp(row: Record<string, unknown> | undefined) {
	// Answers any select().from().where().limit() chain with the given row.
	const chain: Record<string, unknown> = {}
	for (const step of ['select', 'from', 'where']) chain[step] = () => chain
	chain.limit = () => Promise.resolve(row ? [row] : [])
	const deps: AppDeps = {
		db: chain as unknown as Database,
		notifyBridge: {} as unknown as PgNotifyBridge,
		sessionManager: {} as unknown as SessionManager,
		agentStorage: {} as unknown as AgentStorageManager,
		storageProvider: { get: async () => PNG } as unknown as StorageProvider,
	}
	return createApp(deps, { includeExtensions: false })
}

const agentRow = {
	type: 'agent',
	metadata: { avatar_version: 'v1', avatar_content_type: 'image/png' },
}

describe('actor avatar auth exemption', () => {
	const path = `/api/actors/${randomUUID()}/avatar`

	it('serves an agent avatar without an API key', async () => {
		const res = await buildApp(agentRow).request(`${path}?v=v1`)

		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('image/png')
	})

	it('serves a human avatar the same way', async () => {
		const res = await buildApp({ ...agentRow, type: 'human' }).request(`${path}?v=v1`)

		expect(res.status).toBe(200)
	})

	it('returns 404 without the current ?v=', async () => {
		const app = buildApp(agentRow)

		expect((await app.request(path)).status).toBe(404)
		expect((await app.request(`${path}?v=old`)).status).toBe(404)
	})

	it('returns 404 for a missing actor', async () => {
		const res = await buildApp(undefined).request(`${path}?v=v1`)

		expect(res.status).toBe(404)
	})

	it('still requires an API key to upload', async () => {
		const res = await buildApp(agentRow).request(path, { method: 'POST' })

		expect(res.status).toBe(401)
	})

	it('does not extend the exemption to other paths', async () => {
		const app = buildApp(agentRow)

		expect((await app.request('/api/actors/not-a-uuid/avatar')).status).toBe(401)
		expect((await app.request(`${path}/extra`)).status).toBe(401)
		expect((await app.request(`/api/actors/${randomUUID()}`)).status).toBe(401)
	})
})
