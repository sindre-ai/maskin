import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { buildApp } from '../../index'
import { _resetConnectionsForTest } from '../../lib/ws-registry'
import { buildAuthFixture, buildAuthHeaders } from '../fixtures'
import { createMockDb } from '../setup'

// WS-specific test (mock-DB harness — this exercises the fan-out mechanism
// itself, not DB semantics, which the real-Postgres integration tests
// cover): two connected clients under the same identity, one pushes,
// asserting the OTHER receives the fanned-out message and the pusher does
// not receive its own echo. Boots a real HTTP+WS server on an ephemeral
// port, since @hono/node-ws's upgrade handling requires a real Node
// http.Server (see routes/ws.ts's comment on how injectWebSocket works).
describe('GET /sync/ws fan-out', () => {
	afterEach(() => {
		_resetConnectionsForTest()
	})

	it('fans out a push to the other device on the same identity, not back to the pusher', async () => {
		const { db, mockResults } = createMockDb()
		const fixtureA = buildAuthFixture()
		const fixtureB = buildAuthFixture({ ca: fixtureA.ca, identityId: fixtureA.identityId })

		const env = {
			PORT: 0,
			VAERKSTED_SYNC_DATABASE_URL: 'postgres://test',
			VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: fixtureA.ca.publicKey,
		}
		const { app, injectWebSocket } = buildApp(env, db)

		let port = 0
		const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
			const srv = serve({ fetch: app.fetch, port: 0 }, (info: AddressInfo) => {
				port = info.port
				resolve(srv)
			})
		})
		injectWebSocket(server)

		try {
			const wsA = new WebSocket(`ws://localhost:${port}/sync/ws`, {
				headers: buildAuthHeaders(fixtureA),
			})
			const wsB = new WebSocket(`ws://localhost:${port}/sync/ws`, {
				headers: buildAuthHeaders(fixtureB),
			})

			await Promise.all([
				new Promise((resolve, reject) => {
					wsA.on('open', resolve)
					wsA.on('error', reject)
				}),
				new Promise((resolve, reject) => {
					wsB.on('open', resolve)
					wsB.on('error', reject)
				}),
			])

			const messagesA: string[] = []
			const messagesB: string[] = []
			wsA.on('message', (data) => messagesA.push(data.toString()))
			wsB.on('message', (data) => messagesB.push(data.toString()))

			const storedRow = {
				id: 'blob-ws-1',
				deviceId: fixtureA.deviceId,
				identityId: fixtureA.identityId,
				meetingId: 'm1',
				field: 'title',
				logicalClock: 1,
				payload: 'hello from A',
				serverSeq: 1,
				createdAt: new Date('2026-08-08T12:00:00.000Z'),
			}
			mockResults.insert = [storedRow]

			// Device A pushes over plain HTTP (not its own WS connection).
			const pushRes = await fetch(`http://localhost:${port}/sync/push`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(fixtureA) },
				body: JSON.stringify({
					meeting_id: 'm1',
					field: 'title',
					logical_clock: 1,
					payload: 'hello from A',
				}),
			})
			expect(pushRes.status).toBe(201)

			await vi.waitFor(() => expect(messagesB).toHaveLength(1), { timeout: 2000 })

			const parsed = JSON.parse(messagesB[0] ?? '{}')
			expect(parsed).toEqual({
				type: 'sync_blob',
				blob: {
					id: 'blob-ws-1',
					device_id: fixtureA.deviceId,
					identity_id: fixtureA.identityId,
					meeting_id: 'm1',
					field: 'title',
					logical_clock: 1,
					payload: 'hello from A',
					server_seq: 1,
					created_at: '2026-08-08T12:00:00.000Z',
				},
			})

			// The pusher (device A) must not receive its own push echoed back.
			expect(messagesA).toHaveLength(0)

			wsA.close()
			wsB.close()
		} finally {
			await new Promise((resolve) => server.close(resolve))
		}
	})
})
