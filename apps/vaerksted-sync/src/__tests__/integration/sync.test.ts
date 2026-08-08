import { describe, expect, it } from 'vitest'
import { buildApp } from '../../index'
import type { VaerkstedSyncEnv } from '../../lib/env'
import { type AuthFixture, buildAuthFixture, buildAuthHeaders } from '../fixtures'
import { db, testDatabaseUrl } from './global-setup'

// Exercises push/pull against a REAL Postgres — per
// .claude/rules/verification.md's "any DB-writing route/service needs an
// integration test" rule, applied to this app's own schema. Covers what a
// mocked-DB unit test cannot: the bigserial server_seq assignment/ordering,
// the `since` boundary condition against real data, and the consumed_nonce
// primary-key conflict that enforces single-use nonces.
//
// See global-setup.ts for how the database is resolved and why this only
// ever touches a throwaway `vaerksted_sync_test` database — never Maskin's
// or vaerksted-auth's own databases.
describe.skipIf(!testDatabaseUrl)('vaerksted-sync push/pull (real Postgres)', () => {
	function buildTestApp(fixture: AuthFixture) {
		const env: VaerkstedSyncEnv = {
			PORT: 3002,
			VAERKSTED_SYNC_DATABASE_URL: testDatabaseUrl ?? '',
			VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: fixture.ca.publicKey,
		}
		return buildApp(env, db).app
	}

	it('push then pull round trip: the pulled row matches what was pushed, plus server-assigned fields', async () => {
		const fixture = buildAuthFixture()
		const app = buildTestApp(fixture)

		const pushRes = await app.request('/sync/push', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(fixture) },
			body: JSON.stringify({
				meeting_id: 'meeting-round-trip',
				field: 'title',
				logical_clock: 1,
				payload: 'Hello from device A',
			}),
		})
		expect(pushRes.status).toBe(201)
		const pushed = await pushRes.json()
		expect(pushed.meeting_id).toBe('meeting-round-trip')
		expect(pushed.device_id).toBe(fixture.deviceId)
		expect(pushed.identity_id).toBe(fixture.identityId)
		expect(typeof pushed.server_seq).toBe('number')

		const pullRes = await app.request('/sync/pull?since=0', { headers: buildAuthHeaders(fixture) })
		expect(pullRes.status).toBe(200)
		const pulled = await pullRes.json()
		expect(pulled.blobs).toEqual([pushed])
	})

	it('a device can pull sync_blob rows pushed by a different device on the same identity', async () => {
		const fixtureA = buildAuthFixture()
		const fixtureB = buildAuthFixture({ ca: fixtureA.ca, identityId: fixtureA.identityId })
		const app = buildTestApp(fixtureA)

		const pushRes = await app.request('/sync/push', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(fixtureA) },
			body: JSON.stringify({
				meeting_id: 'meeting-cross-device',
				field: 'notes',
				logical_clock: 1,
				payload: 'from device A',
			}),
		})
		expect(pushRes.status).toBe(201)

		const pullRes = await app.request('/sync/pull?since=0', { headers: buildAuthHeaders(fixtureB) })
		expect(pullRes.status).toBe(200)
		const pulled = await pullRes.json()
		expect(
			pulled.blobs.some((b: { meeting_id: string }) => b.meeting_id === 'meeting-cross-device'),
		).toBe(true)
	})

	it('since= is an exclusive boundary: exactly-at excludes that row, one-below includes it', async () => {
		const fixture = buildAuthFixture()
		const app = buildTestApp(fixture)

		const pushed: Array<{ id: string; server_seq: number }> = []
		for (let i = 0; i < 3; i++) {
			const res = await app.request('/sync/push', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(fixture) },
				body: JSON.stringify({
					meeting_id: 'meeting-pagination',
					field: 'title',
					logical_clock: i,
					payload: `payload-${i}`,
				}),
			})
			expect(res.status).toBe(201)
			pushed.push(await res.json())
		}
		const [first, middle, last] = pushed
		if (!first || !middle || !last) throw new Error('setup failed')

		const atBoundary = await app.request(`/sync/pull?since=${middle.server_seq}`, {
			headers: buildAuthHeaders(fixture),
		})
		const atBoundaryBody = await atBoundary.json()
		expect(atBoundaryBody.blobs.map((b: { id: string }) => b.id)).toEqual([last.id])

		const belowBoundary = await app.request(`/sync/pull?since=${middle.server_seq - 1}`, {
			headers: buildAuthHeaders(fixture),
		})
		const belowBoundaryBody = await belowBoundary.json()
		expect(belowBoundaryBody.blobs.map((b: { id: string }) => b.id)).toEqual([middle.id, last.id])
	})

	it('rejects a replayed nonce: the second push using the same nonce/timestamp/signature 401s', async () => {
		const fixture = buildAuthFixture()
		const app = buildTestApp(fixture)
		const headers = buildAuthHeaders(fixture)

		const first = await app.request('/sync/push', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify({
				meeting_id: 'meeting-replay',
				field: 'title',
				logical_clock: 1,
				payload: 'first attempt',
			}),
		})
		expect(first.status).toBe(201)

		const second = await app.request('/sync/push', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify({
				meeting_id: 'meeting-replay',
				field: 'title',
				logical_clock: 2,
				payload: 'replayed attempt',
			}),
		})
		expect(second.status).toBe(401)

		// The replayed request must not have inserted a second row.
		const pullRes = await app.request('/sync/pull?since=0', { headers: buildAuthHeaders(fixture) })
		const pulled = await pullRes.json()
		const matching = pulled.blobs.filter(
			(b: { meeting_id: string }) => b.meeting_id === 'meeting-replay',
		)
		expect(matching).toHaveLength(1)
	})
})
