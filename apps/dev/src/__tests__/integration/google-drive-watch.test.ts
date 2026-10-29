import { randomUUID } from 'node:crypto'
import { events, integrations, webhookDeliveries } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { computeChannelToken } from '../../lib/integrations/providers/google-drive/channel-token'
import type { DriveClient } from '../../lib/integrations/providers/google-drive/client'
import {
	clearDriveParentCache,
	runDriveFanOut,
} from '../../lib/integrations/providers/google-drive/fan-out'
import { watchFolder } from '../../lib/integrations/providers/google-drive/tools/watch-folder'
import { renewDriveWatch } from '../../lib/integrations/providers/google-drive/watch'
import { stopDriveWatch as stopWatchEntry } from '../../lib/integrations/providers/google-drive/watched-folders'
import { processDriveWebhook } from '../../lib/integrations/providers/google-drive/webhook-handler'
import { webhookApp } from '../../routes/integrations'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// The Drive folder-watch path against real Postgres: channel-id routing, the
// webhook_deliveries dedup, the cursor compare-and-set, the lastFiredAt write
// (a single jsonb UPDATE over the row's current array, the shape known-pitfalls.md
// says mocked-DB tests cannot check) and the watch_folder tool. Google is a fake
// DriveClient; the token mint is stubbed, and the rows carry a sealed placeholder token so the
// audited credential read the Drive tools make can decrypt them.

vi.mock('../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: class {
		async getValidToken() {
			return 'ya29.test'
		}
	},
}))

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn(async () => undefined),
}))

process.env.GOOGLE_DRIVE_CHANNEL_TOKEN_SECRET = 'drive-channel-secret'
process.env.MASKIN_PUBLIC_URL = 'https://api.maskin.test'

const FOLDER = 'application/vnd.google-apps.folder'

type FakeClient = {
	[K in keyof DriveClient]: ReturnType<typeof vi.fn>
} & DriveClient

function fakeClient(over: Partial<Record<keyof DriveClient, unknown>> = {}): FakeClient {
	return {
		listFiles: vi.fn(async () => ({ files: [] })),
		getStartPageToken: vi.fn(async () => 'fresh-token'),
		watchChanges: vi.fn(async (_t: string, p: { expiration: number }) => ({
			resourceId: 'res-new',
			expiration: String(p.expiration),
		})),
		stopChannel: vi.fn(async () => undefined),
		listChanges: vi.fn(async () => ({ changes: [], newStartPageToken: '100' })),
		getFile: vi.fn(async () => ({ id: 'x', name: 'x', mimeType: FOLDER })),
		...over,
	} as unknown as FakeClient
}

let counter = 0

async function insertDriveRow(
	workspaceId: string,
	drive: Record<string, unknown>,
	overrides: { status?: 'active' | 'error' | 'revoked'; externalId?: string } = {},
) {
	counter += 1
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'google-drive',
			status: overrides.status ?? 'active',
			externalId: overrides.externalId ?? `human${counter}@acme.test`,
			credentials: encrypt(JSON.stringify({ accessToken: 'ya29.test' })),
			config: { system_actor_id: getTestActorId(), drive },
			createdBy: getTestActorId(),
		})
		.returning()
	return row as NonNullable<typeof row>
}

async function drive(id: string) {
	const [row] = await db.select().from(integrations).where(eq(integrations.id, id))
	return (row?.config as { system_actor_id?: string; drive?: Record<string, unknown> }).drive as {
		startPageToken?: string
		channelId?: string
		channelResourceId?: string
		watchedFolders?: Array<{
			folderId: string
			lastFiredAt?: string
			eventTypes?: string[]
			path?: string
			name?: string
		}>
	}
}

async function driveEvents(workspaceId: string) {
	return db
		.select()
		.from(events)
		.where(and(eq(events.workspaceId, workspaceId), eq(events.entityType, 'google_drive.file')))
}

const watch = (folderId: string, extra: Record<string, unknown> = {}) => ({
	folderId,
	name: `Folder ${folderId}`,
	addedAt: '2026-10-01T09:00:00.000Z',
	...extra,
})

const now = () => new Date().toISOString()

beforeEach(() => {
	clearDriveParentCache()
})

describe('runDriveFanOut (integration)', () => {
	it('emits one signal per change in a watched folder or a descendant, and nothing outside', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await insertDriveRow(ws.id, {
			peopleId: 'p-1',
			channelId: 'chan-a',
			startPageToken: '100',
			watchedFolders: [watch('F1'), watch('F2')],
		})
		const t = now()
		const client = fakeClient({
			listChanges: vi.fn(async () => ({
				newStartPageToken: '101',
				changes: [
					{
						fileId: 'X',
						time: t,
						file: {
							id: 'X',
							name: 'new.pdf',
							mimeType: 'application/pdf',
							parents: ['F1'],
							createdTime: t,
						},
					},
					{
						fileId: 'Y',
						time: t,
						file: {
							id: 'Y',
							name: 'deep.doc',
							mimeType: 'text/plain',
							parents: ['SUB'],
							createdTime: '2020-01-01T00:00:00.000Z',
						},
					},
					{
						fileId: 'Z',
						time: t,
						file: { id: 'Z', name: 'elsewhere', mimeType: 'text/plain', parents: ['ELSEWHERE'] },
					},
					{
						fileId: 'T',
						time: t,
						file: { id: 'T', name: 'old', mimeType: 'text/plain', parents: ['F1'], trashed: true },
					},
				],
			})),
			getFile: vi.fn(async (_tok: string, id: string) => {
				if (id === 'SUB') return { id, name: 'sub', mimeType: FOLDER, parents: ['F1'] }
				return { id, name: id, mimeType: FOLDER, parents: [] }
			}),
		})

		const out = await runDriveFanOut(db, row.id, { client })

		expect(out.emitted).toBe(3)
		const rows = await driveEvents(ws.id)
		expect(rows.map((r) => r.action).sort()).toEqual(['created', 'trashed', 'updated'])
		for (const r of rows) {
			expect(r.entityId).toBe(row.id)
			expect(r.actorId).toBe(getTestActorId())
			expect(r.data).toMatchObject({ folderId: 'F1', eventType: r.action })
		}
		const created = rows.find((r) => r.action === 'created')
		expect(created?.data).toMatchObject({
			fileId: 'X',
			name: 'new.pdf',
			mimeType: 'application/pdf',
			changeTime: t,
		})

		const stored = await drive(row.id)
		expect(stored.startPageToken).toBe('101')
		// lastFiredAt lands on the folder that fired, not on its sibling, and the
		// rest of the row's config survives.
		expect(stored.watchedFolders?.map((w) => w.folderId)).toEqual(['F1', 'F2'])
		expect(stored.watchedFolders?.[0]?.lastFiredAt).toBeTypeOf('string')
		expect(stored.watchedFolders?.[1]?.lastFiredAt).toBeUndefined()
		expect(stored.channelId).toBe('chan-a')
	})

	it('follows nextPageToken across pages, committing the cursor per page', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await insertDriveRow(ws.id, {
			startPageToken: '100',
			watchedFolders: [watch('F1')],
		})
		const t = now()
		const change = (id: string) => ({
			fileId: id,
			time: t,
			file: { id, name: id, mimeType: 'text/plain', parents: ['F1'], createdTime: t },
		})
		const listChanges = vi
			.fn()
			.mockResolvedValueOnce({ changes: [change('A')], nextPageToken: 'p2' })
			.mockResolvedValueOnce({ changes: [change('B')], newStartPageToken: '105' })

		const out = await runDriveFanOut(db, row.id, { client: fakeClient({ listChanges }) })

		expect(out).toEqual({ emitted: 2, pages: 2 })
		expect(listChanges.mock.calls.map((c) => (c[1] as { pageToken: string }).pageToken)).toEqual([
			'100',
			'p2',
		])
		expect((await drive(row.id)).startPageToken).toBe('105')
	})

	it('with no watched folders, moves the cursor to now without reading the feed', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await insertDriveRow(ws.id, { startPageToken: '1', watchedFolders: [] })
		const client = fakeClient()

		await runDriveFanOut(db, row.id, { client })

		expect(client.listChanges).not.toHaveBeenCalled()
		expect((await drive(row.id)).startPageToken).toBe('fresh-token')
	})

	it('honours a per-folder eventTypes filter', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await insertDriveRow(ws.id, {
			startPageToken: '100',
			watchedFolders: [watch('F1', { eventTypes: ['created'] })],
		})
		const t = now()
		const client = fakeClient({
			listChanges: vi.fn(async () => ({
				newStartPageToken: '101',
				changes: [
					{
						fileId: 'N',
						time: t,
						file: { id: 'N', name: 'n', mimeType: 'text/plain', parents: ['F1'], createdTime: t },
					},
					{
						fileId: 'U',
						time: t,
						file: {
							id: 'U',
							name: 'u',
							mimeType: 'text/plain',
							parents: ['F1'],
							createdTime: '2020-01-01T00:00:00.000Z',
						},
					},
				],
			})),
		})

		await runDriveFanOut(db, row.id, { client })

		expect((await driveEvents(ws.id)).map((r) => r.action)).toEqual(['created'])
	})

	it('reports a deletion for a file seen in the last 5 minutes, and drops one it never saw', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await insertDriveRow(ws.id, {
			startPageToken: '100',
			watchedFolders: [watch('F1')],
		})
		const t = now()
		const seen = fakeClient({
			listChanges: vi.fn(async () => ({
				newStartPageToken: '101',
				changes: [
					{
						fileId: 'D',
						time: t,
						file: {
							id: 'D',
							name: 'd',
							mimeType: 'text/plain',
							parents: ['F1'],
							createdTime: '2020-01-01T00:00:00.000Z',
						},
					},
				],
			})),
		})
		await runDriveFanOut(db, row.id, { client: seen })

		const removed = fakeClient({
			listChanges: vi.fn(async () => ({
				newStartPageToken: '102',
				changes: [
					{ fileId: 'D', removed: true, time: t },
					{ fileId: 'NEVER-SEEN', removed: true, time: t },
				],
			})),
		})
		await runDriveFanOut(db, row.id, { client: removed })

		const rows = await driveEvents(ws.id)
		const deleted = rows.filter((r) => r.action === 'deleted')
		expect(deleted).toHaveLength(1)
		expect(deleted[0]?.data).toMatchObject({ fileId: 'D', folderId: 'F1', eventType: 'deleted' })
		expect(deleted[0]?.data).not.toHaveProperty('name')
		// A removed file's metadata is gone, so Drive is not asked for its parents.
		expect(removed.getFile).not.toHaveBeenCalled()
	})

	it('emits once when a concurrent run moved the cursor first', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await insertDriveRow(ws.id, {
			startPageToken: '100',
			watchedFolders: [watch('F1')],
		})
		const t = now()
		const client = fakeClient({
			listChanges: vi.fn(async () => {
				// The other delivery commits its page while this one is still reading.
				await db
					.update(integrations)
					.set({
						config: {
							system_actor_id: getTestActorId(),
							drive: { startPageToken: '999', watchedFolders: [watch('F1')] },
						},
					})
					.where(eq(integrations.id, row.id))
				return {
					newStartPageToken: '101',
					changes: [
						{
							fileId: 'X',
							time: t,
							file: { id: 'X', name: 'x', mimeType: 'text/plain', parents: ['F1'], createdTime: t },
						},
					],
				}
			}),
		})

		const out = await runDriveFanOut(db, row.id, { client })

		expect(out.emitted).toBe(0)
		expect(await driveEvents(ws.id)).toHaveLength(0)
		expect((await drive(row.id)).startPageToken).toBe('999')
	})

	it('does not bring back a watch the user stopped while the fan-out ran', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await insertDriveRow(ws.id, {
			startPageToken: '100',
			watchedFolders: [watch('F1'), watch('F2')],
		})
		const t = now()
		const client = fakeClient({
			listChanges: vi.fn(async () => {
				await stopWatchEntry(db, ws.id, 'F2')
				return {
					newStartPageToken: '101',
					changes: [
						{
							fileId: 'X',
							time: t,
							file: { id: 'X', name: 'x', mimeType: 'text/plain', parents: ['F1'], createdTime: t },
						},
					],
				}
			}),
		})

		await runDriveFanOut(db, row.id, { client })

		const stored = await drive(row.id)
		expect(stored.watchedFolders?.map((w) => w.folderId)).toEqual(['F1'])
		expect(stored.watchedFolders?.[0]?.lastFiredAt).toBeTypeOf('string')
		expect(stored.startPageToken).toBe('101')
	})

	it('leaves the cursor and emits nothing when Drive fails mid-run', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await insertDriveRow(ws.id, {
			startPageToken: '100',
			watchedFolders: [watch('F1')],
		})
		const client = fakeClient({
			listChanges: vi.fn(async () => {
				throw new Error('drive down')
			}),
		})

		await expect(runDriveFanOut(db, row.id, { client })).rejects.toThrow('drive down')

		expect((await drive(row.id)).startPageToken).toBe('100')
		expect(await driveEvents(ws.id)).toHaveLength(0)
	})
})

describe('processDriveWebhook (integration)', () => {
	const headersFor = (channelId: string, over: Record<string, string> = {}) => ({
		'x-goog-channel-id': channelId,
		'x-goog-channel-token': computeChannelToken(channelId),
		'x-goog-resource-id': 'res-1',
		'x-goog-resource-state': 'change',
		'x-goog-message-number': '1',
		...over,
	})

	const oneChange = () => {
		const t = now()
		return fakeClient({
			listChanges: vi.fn(async () => ({
				newStartPageToken: '101',
				changes: [
					{
						fileId: 'X',
						time: t,
						file: { id: 'X', name: 'x', mimeType: 'text/plain', parents: ['F1'], createdTime: t },
					},
				],
			})),
		})
	}

	async function channelRow(workspaceId: string, status: 'active' | 'revoked' = 'active') {
		const channelId = randomUUID()
		const row = await insertDriveRow(
			workspaceId,
			{ channelId, startPageToken: '100', watchedFolders: [watch('F1')] },
			{ status },
		)
		return { channelId, row }
	}

	it('rejects a missing or wrong token before it touches the row', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const { channelId } = await channelRow(ws.id)
		const client = oneChange()

		const wrong = await processDriveWebhook(
			db,
			headersFor(channelId, { 'x-goog-channel-token': 'nope' }),
			{ client },
		)
		const other = await processDriveWebhook(
			db,
			headersFor(channelId, { 'x-goog-channel-token': computeChannelToken('another-channel') }),
			{ client },
		)
		const missing = await processDriveWebhook(db, { 'x-goog-channel-id': channelId }, { client })

		expect(wrong.status).toBe(401)
		expect(other.status).toBe(401)
		expect(missing.status).toBe(400)
		expect(client.listChanges).not.toHaveBeenCalled()
		expect(await driveEvents(ws.id)).toHaveLength(0)
	})

	it('drops the sync handshake silently: no claim, no read', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const { channelId } = await channelRow(ws.id)
		const client = oneChange()

		const res = await processDriveWebhook(
			db,
			headersFor(channelId, { 'x-goog-resource-state': 'sync', 'x-goog-message-number': '1' }),
			{ client },
		)

		expect(res.status).toBe(200)
		expect(res.body).toEqual({ ok: true, skipped: true })
		expect(client.listChanges).not.toHaveBeenCalled()
		const claims = await db
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.externalId, `${channelId}:1`))
		expect(claims).toHaveLength(0)
	})

	it('fans a valid change out, marks the delivery processed, and dedups the retry', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const { channelId } = await channelRow(ws.id)
		const client = oneChange()

		const first = await processDriveWebhook(db, headersFor(channelId), { client })
		const retry = await processDriveWebhook(db, headersFor(channelId), { client })

		expect(first).toMatchObject({ status: 200, body: { ok: true, emitted: 1 } })
		expect(retry).toMatchObject({ status: 200, body: { ok: true, duplicate: true } })
		expect(client.listChanges).toHaveBeenCalledTimes(1)
		expect(await driveEvents(ws.id)).toHaveLength(1)
		const [claim] = await db
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.externalId, `${channelId}:1`))
		expect(claim?.workspaceId).toBe(ws.id)
		expect(claim?.processedAt).not.toBeNull()
	})

	it('S5: two workspaces on the same Google account each get only their own channel delivery', async () => {
		const wsA = await insertWorkspace(db, getTestActorId())
		const wsB = await insertWorkspace(db, getTestActorId())
		const shared = `shared${counter}@acme.test`
		const channelA = randomUUID()
		const channelB = randomUUID()
		await insertDriveRow(
			wsA.id,
			{ channelId: channelA, startPageToken: '100', watchedFolders: [watch('F1')] },
			{ externalId: shared },
		)
		await insertDriveRow(
			wsB.id,
			{ channelId: channelB, startPageToken: '100', watchedFolders: [watch('F1')] },
			{ externalId: shared },
		)

		await processDriveWebhook(db, headersFor(channelA), { client: oneChange() })

		expect(await driveEvents(wsA.id)).toHaveLength(1)
		expect(await driveEvents(wsB.id)).toHaveLength(0)
	})

	it('ignores a channel whose row is no longer active, or unknown', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const { channelId } = await channelRow(ws.id, 'revoked')
		const client = oneChange()

		const revoked = await processDriveWebhook(db, headersFor(channelId), { client })
		const unknown = await processDriveWebhook(db, headersFor(randomUUID()), { client })

		expect(revoked.body).toEqual({ ok: true, skipped: true })
		expect(unknown.body).toEqual({ ok: true, skipped: true })
		expect(client.listChanges).not.toHaveBeenCalled()
	})

	it('releases the claim and answers 500 when the fan-out fails, so the retry reprocesses', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const { channelId } = await channelRow(ws.id)
		const failing = fakeClient({
			listChanges: vi.fn(async () => {
				throw new Error('drive down')
			}),
		})

		const failed = await processDriveWebhook(db, headersFor(channelId), { client: failing })
		const retried = await processDriveWebhook(db, headersFor(channelId), { client: oneChange() })

		expect(failed.status).toBe(500)
		expect(retried).toMatchObject({ status: 200, body: { ok: true, emitted: 1 } })
	})
})

describe('POST /api/webhooks/google-drive (route)', () => {
	const app = () => createIntegrationApp({ path: '/api/webhooks', module: webhookApp })

	it('takes an empty body, as Drive sends, and acknowledges the sync handshake', async () => {
		const channelId = randomUUID()
		const res = await app().request('/api/webhooks/google-drive', {
			method: 'POST',
			headers: {
				'X-Goog-Channel-ID': channelId,
				'X-Goog-Channel-Token': computeChannelToken(channelId),
				'X-Goog-Resource-State': 'sync',
				'X-Goog-Message-Number': '1',
			},
		})

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, skipped: true })
	})

	it('answers 401 to a bad token and never falls through to the generic provider route', async () => {
		const res = await app().request('/api/webhooks/google-drive', {
			method: 'POST',
			headers: {
				'X-Goog-Channel-ID': randomUUID(),
				'X-Goog-Channel-Token': 'forged',
				'X-Goog-Resource-State': 'change',
				'X-Goog-Message-Number': '2',
			},
		})

		expect(res.status).toBe(401)
	})
})

describe('channel lifecycle (integration)', () => {
	it('renewal mints a new channel id, keeps the cursor and the watches, and stops the old channel', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await insertDriveRow(ws.id, {
			peopleId: 'p-1',
			channelId: 'old-chan',
			channelResourceId: 'old-res',
			channelExpiresAt: Date.now() + 1000,
			startPageToken: '500',
			watchedFolders: [watch('F1')],
		})
		const client = fakeClient()

		await renewDriveWatch(db, row.id, client)

		const stored = await drive(row.id)
		expect(stored.channelId).toBeTypeOf('string')
		expect(stored.channelId).not.toBe('old-chan')
		expect(stored.channelResourceId).toBe('res-new')
		expect(stored.startPageToken).toBe('500')
		expect(stored.watchedFolders?.map((w) => w.folderId)).toEqual(['F1'])
		expect(client.getStartPageToken).not.toHaveBeenCalled()
		const watchArgs = client.watchChanges.mock.calls[0]?.[1] as {
			pageToken: string
			address: string
			token: string
			channelId: string
		}
		expect(watchArgs.pageToken).toBe('500')
		expect(watchArgs.address).toBe('https://api.maskin.test/api/webhooks/google-drive')
		expect(watchArgs.token).toBe(computeChannelToken(watchArgs.channelId))
		expect(client.stopChannel).toHaveBeenCalledWith('ya29.test', {
			id: 'old-chan',
			resourceId: 'old-res',
		})
	})

	it('a row with no channel yet gets one, seeded from getStartPageToken', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await insertDriveRow(ws.id, { peopleId: 'p-1' })
		const client = fakeClient()

		await renewDriveWatch(db, row.id, client)

		const stored = await drive(row.id)
		expect(stored.startPageToken).toBe('fresh-token')
		expect(stored.channelId).toBeTypeOf('string')
		expect(client.stopChannel).not.toHaveBeenCalled()
	})
})

describe('google_drive__watch_folder (integration)', () => {
	const ctxFor = (workspaceId: string, client: DriveClient) => ({
		db,
		workspaceId,
		actorId: getTestActorId(),
		client,
	})

	const folderClient = (extra: Partial<Record<keyof DriveClient, unknown>> = {}) =>
		fakeClient({
			getFile: vi.fn(async (_tok: string, id: string) => {
				if (id === 'ROOT') return { id, name: 'My Drive', mimeType: FOLDER }
				if (id === 'PROJ') return { id, name: 'Projects', mimeType: FOLDER, parents: ['ROOT'] }
				if (id === 'FILE') return { id, name: 'a.pdf', mimeType: 'application/pdf' }
				return { id, name: 'Inbox', mimeType: FOLDER, parents: ['PROJ'] }
			}),
			...extra,
		})

	const liveChannel = {
		channelId: 'live',
		channelResourceId: 'res',
		channelExpiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
		startPageToken: '1',
	}

	it('stores name, ancestor path and addedAt, and returns { ok: true, watchedFolders }', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await insertDriveRow(ws.id, liveChannel)
		const client = folderClient()

		const out = await watchFolder(ctxFor(ws.id, client), { folderId: 'F1' })

		expect(out.ok).toBe(true)
		expect(out.watchedFolders).toHaveLength(1)
		expect(out.watchedFolders[0]).toMatchObject({
			folderId: 'F1',
			name: 'Inbox',
			path: 'My Drive/Projects',
		})
		expect(Date.parse(out.watchedFolders[0]?.addedAt ?? '')).not.toBeNaN()
		const stored = await drive(row.id)
		expect(stored.watchedFolders?.[0]?.folderId).toBe('F1')
		// The channel was live, so no repair.
		expect(client.watchChanges).not.toHaveBeenCalled()
	})

	it('dedups: watching the same folder twice changes nothing and asks Drive nothing', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await insertDriveRow(ws.id, liveChannel)
		await watchFolder(ctxFor(ws.id, folderClient()), { folderId: 'F1' })
		const again = folderClient()

		const out = await watchFolder(ctxFor(ws.id, again), { folderId: 'F1' })

		expect(out.watchedFolders).toHaveLength(1)
		expect(again.getFile).not.toHaveBeenCalled()
		expect((await drive(row.id)).watchedFolders).toHaveLength(1)
	})

	it('caps at 20 watched folders per workspace with a clear error', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const folders = Array.from({ length: 20 }, (_, i) => watch(`F${i}`))
		const row = await insertDriveRow(ws.id, { ...liveChannel, watchedFolders: folders })

		await expect(
			watchFolder(ctxFor(ws.id, folderClient()), { folderId: 'ONE-TOO-MANY' }),
		).rejects.toMatchObject({
			code: 'INVALID_INPUT',
			message: expect.stringContaining('20'),
		})
		expect((await drive(row.id)).watchedFolders).toHaveLength(20)
	})

	it('refuses an id that is not a folder', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await insertDriveRow(ws.id, liveChannel)

		await expect(
			watchFolder(ctxFor(ws.id, folderClient()), { folderId: 'FILE' }),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' })
		expect((await drive(row.id)).watchedFolders ?? []).toHaveLength(0)
	})

	it('stores the eventTypes it was given, in canonical order', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await insertDriveRow(ws.id, liveChannel)

		await watchFolder(ctxFor(ws.id, folderClient()), {
			folderId: 'F1',
			eventTypes: ['trashed', 'created'],
		})

		expect((await drive(row.id)).watchedFolders?.[0]?.eventTypes).toEqual(['created', 'trashed'])
	})

	it('repairs a row whose channel lapsed before adding the watch', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await insertDriveRow(ws.id, {
			channelId: 'dead',
			channelResourceId: 'res',
			channelExpiresAt: Date.now() - 1000,
			startPageToken: '1',
		})
		const client = folderClient()

		await watchFolder(ctxFor(ws.id, client), { folderId: 'F1' })

		expect(client.watchChanges).toHaveBeenCalledTimes(1)
		const stored = await drive(row.id)
		expect(stored.channelId).not.toBe('dead')
		expect(stored.watchedFolders?.[0]?.folderId).toBe('F1')
	})

	it('S8: a workspace never sees or changes another workspace watches', async () => {
		const wsA = await insertWorkspace(db, getTestActorId())
		const wsB = await insertWorkspace(db, getTestActorId())
		const rowA = await insertDriveRow(wsA.id, { ...liveChannel, watchedFolders: [watch('A1')] })
		await insertDriveRow(wsB.id, liveChannel)

		const out = await watchFolder(ctxFor(wsB.id, folderClient()), { folderId: 'F1' })

		expect(out.watchedFolders.map((w) => w.folderId)).toEqual(['F1'])
		expect((await drive(rowA.id)).watchedFolders?.map((w) => w.folderId)).toEqual(['A1'])
	})
})
