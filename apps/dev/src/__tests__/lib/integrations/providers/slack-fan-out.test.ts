import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '../../../../lib/integrations/types'

const getValidTokenMock = vi.hoisted(() => vi.fn())
vi.mock('../../../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: class {
		getValidToken = getValidTokenMock
	},
}))

vi.mock('../../../../lib/integrations/registry', () => ({
	getProvider: vi.fn(() => ({ config: { name: 'slack' } })),
}))

interface FakeIntegrationRow {
	id: string
	provider: string
	workspaceId: string
	config: { system_actor_id?: string } | null
}

interface FakeStorage {
	puts: Array<{ key: string; size: number }>
	put: (key: string, data: Buffer) => Promise<void>
}

function tableName(table: unknown): string {
	if (table && typeof table === 'object') {
		if ('__isTaggedFiles' in table) return 'files'
		if ('__isTaggedEvents' in table) return 'events'
		if ('__isTaggedIntegrations' in table) return 'integrations'
	}
	return 'unknown'
}

function makeFakeDb(integration: FakeIntegrationRow | null) {
	const inserted: Array<{ table: string; values: unknown }> = []
	const deleted: Array<{ table: string }> = []

	const db = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: () => Promise.resolve(integration ? [integration] : []),
				}),
			}),
		}),
		insert: (table: unknown) => ({
			values: (values: unknown) => {
				const name = tableName(table)
				inserted.push({ table: name, values })
				if (name === 'files') {
					const row = Array.isArray(values) ? values[0] : values
					return { returning: () => Promise.resolve([row]) }
				}
				return Promise.resolve()
			},
		}),
		delete: (table: unknown) => ({
			where: () => {
				deleted.push({ table: tableName(table) })
				return Promise.resolve()
			},
		}),
	}

	return { db, inserted, deleted }
}

function makeFakeStorage(): FakeStorage {
	const puts: Array<{ key: string; size: number }> = []
	return {
		puts,
		put: async (key: string, data: Buffer) => {
			puts.push({ key, size: data.byteLength })
		},
	}
}

function fakeFiles() {
	return [
		{
			id: 'F123',
			name: 'screenshot.png',
			mimetype: 'image/png',
			url_private: 'https://files.slack.com/files-pri/T1-F123/screenshot.png',
		},
		{
			id: 'F456',
			name: 'log.txt',
			mimetype: 'text/plain',
			url_private_download: 'https://files.slack.com/files-pri/T1-F456/download/log.txt',
		},
	]
}

function makeEvent(files: unknown[] | null): NormalizedEvent {
	const event: Record<string, unknown> = { type: 'message', text: 'hi', user: 'U1', channel: 'C1' }
	if (files) event.files = files
	return {
		entityType: 'slack.channel_message',
		action: 'created',
		installationId: 'T1',
		data: {
			type: 'event_callback',
			team_id: 'T1',
			event,
		},
	}
}

// Replace the schema imports with our tagged objects so the fan-out's
// db.insert(files) / db.insert(eventsTable) calls land in our fake.
vi.mock('@maskin/db/schema', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return {
		...actual,
		files: { __isTaggedFiles: true },
		events: { __isTaggedEvents: true },
		integrations: { __isTaggedIntegrations: true },
	}
})

describe('slackWebhookFanOut', () => {
	beforeEach(() => {
		getValidTokenMock.mockReset().mockResolvedValue('xoxb-test')
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('passes the event through unchanged when no files are attached', async () => {
		const { slackWebhookFanOut } = await import(
			'../../../../lib/integrations/providers/slack/fan-out'
		)
		const { db } = makeFakeDb({
			id: 'int-1',
			provider: 'slack',
			workspaceId: 'ws-1',
			config: { system_actor_id: 'actor-1' },
		})
		const storage = makeFakeStorage()
		const normalized = makeEvent(null)

		const result = await slackWebhookFanOut({
			db: db as never,
			storage,
			integrationId: 'int-1',
			workspaceId: 'ws-1',
			normalized,
		})

		expect(result).toEqual([normalized])
		expect(storage.puts).toHaveLength(0)
	})

	it('downloads each file and adds maskin_file_ids onto the normalized event', async () => {
		const { slackWebhookFanOut } = await import(
			'../../../../lib/integrations/providers/slack/fan-out'
		)
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			arrayBuffer: () => Promise.resolve(new TextEncoder().encode('payload').buffer),
		} as unknown as Response)

		const { db, inserted } = makeFakeDb({
			id: 'int-1',
			provider: 'slack',
			workspaceId: 'ws-1',
			config: { system_actor_id: 'actor-1' },
		})
		const storage = makeFakeStorage()

		const result = await slackWebhookFanOut({
			db: db as never,
			storage,
			integrationId: 'int-1',
			workspaceId: 'ws-1',
			normalized: makeEvent(fakeFiles()),
		})

		expect(result).toHaveLength(1)
		const [out] = result
		expect(out).toBeDefined()
		const data = out?.data as Record<string, unknown>
		const fileIds = data.maskin_file_ids as string[]
		expect(fileIds).toHaveLength(2)
		expect(fileIds.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)

		// Both files were downloaded with the bot token
		expect(fetchSpy).toHaveBeenCalledTimes(2)
		const firstCall = fetchSpy.mock.calls[0]
		expect(firstCall?.[1]).toMatchObject({ headers: { Authorization: 'Bearer xoxb-test' } })

		// Both files were stored in S3 and inserted into the files table
		expect(storage.puts).toHaveLength(2)
		const fileInserts = inserted.filter((i) => i.table === 'files')
		expect(fileInserts).toHaveLength(2)
		const fileEventInserts = inserted.filter(
			(i) => i.table === 'events' && (i.values as { entityType?: string })?.entityType === 'file',
		)
		expect(fileEventInserts).toHaveLength(2)

		// Slack ↔ Maskin mapping is preserved on the enriched event so the agent
		// can correlate text references with the persisted bytes.
		const mapping = data.maskin_files as Array<Record<string, unknown>>
		expect(mapping).toHaveLength(2)
		expect(mapping[0]?.slack_file_id).toBe('F123')
		expect(mapping[1]?.slack_file_id).toBe('F456')
	})

	it('skips an individual file when its download fails but persists the rest', async () => {
		const { slackWebhookFanOut } = await import(
			'../../../../lib/integrations/providers/slack/fan-out'
		)
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce({
				ok: false,
				status: 403,
				arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
			} as unknown as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				arrayBuffer: () => Promise.resolve(new TextEncoder().encode('ok').buffer),
			} as unknown as Response)

		const { db } = makeFakeDb({
			id: 'int-1',
			provider: 'slack',
			workspaceId: 'ws-1',
			config: { system_actor_id: 'actor-1' },
		})
		const storage = makeFakeStorage()

		const result = await slackWebhookFanOut({
			db: db as never,
			storage,
			integrationId: 'int-1',
			workspaceId: 'ws-1',
			normalized: makeEvent(fakeFiles()),
		})

		const data = result[0]?.data as Record<string, unknown>
		expect(data.maskin_file_ids).toHaveLength(1)
		expect(storage.puts).toHaveLength(1)
	})

	it('returns the event unchanged when storage is unavailable', async () => {
		const { slackWebhookFanOut } = await import(
			'../../../../lib/integrations/providers/slack/fan-out'
		)
		const { db } = makeFakeDb({
			id: 'int-1',
			provider: 'slack',
			workspaceId: 'ws-1',
			config: { system_actor_id: 'actor-1' },
		})
		const normalized = makeEvent(fakeFiles())

		const result = await slackWebhookFanOut({
			db: db as never,
			storage: undefined,
			integrationId: 'int-1',
			workspaceId: 'ws-1',
			normalized,
		})

		expect(result).toEqual([normalized])
	})

	it('returns the event unchanged when the integration has no system actor', async () => {
		const { slackWebhookFanOut } = await import(
			'../../../../lib/integrations/providers/slack/fan-out'
		)
		const { db } = makeFakeDb({
			id: 'int-1',
			provider: 'slack',
			workspaceId: 'ws-1',
			config: {},
		})
		const storage = makeFakeStorage()
		const normalized = makeEvent(fakeFiles())

		const result = await slackWebhookFanOut({
			db: db as never,
			storage,
			integrationId: 'int-1',
			workspaceId: 'ws-1',
			normalized,
		})

		expect(result).toEqual([normalized])
		expect(storage.puts).toHaveLength(0)
	})

	it('downloads files in parallel rather than sequentially', async () => {
		const { slackWebhookFanOut } = await import(
			'../../../../lib/integrations/providers/slack/fan-out'
		)
		let inFlight = 0
		let maxInFlight = 0
		vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
			inFlight++
			maxInFlight = Math.max(maxInFlight, inFlight)
			await new Promise((r) => setTimeout(r, 20))
			inFlight--
			return {
				ok: true,
				status: 200,
				arrayBuffer: () => Promise.resolve(new TextEncoder().encode('payload').buffer),
			} as unknown as Response
		}) as typeof fetch)

		const { db } = makeFakeDb({
			id: 'int-1',
			provider: 'slack',
			workspaceId: 'ws-1',
			config: { system_actor_id: 'actor-1' },
		})
		const storage = makeFakeStorage()

		await slackWebhookFanOut({
			db: db as never,
			storage,
			integrationId: 'int-1',
			workspaceId: 'ws-1',
			normalized: makeEvent(fakeFiles()),
		})

		// Both fetches should overlap — sequential execution would peak at 1.
		expect(maxInFlight).toBeGreaterThanOrEqual(2)
	})
})
