import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetValidToken = vi.fn()
vi.mock('../../../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: vi.fn().mockImplementation(() => ({
		getValidToken: mockGetValidToken,
	})),
}))

// Stub the registry so getProvider('github') returns something shaped like a
// resolved provider without pulling env-driven auth into unit-test scope.
vi.mock('../../../../lib/integrations/registry', () => ({
	getProvider: vi.fn().mockReturnValue({
		config: { name: 'github', displayName: 'GitHub', auth: { type: 'oauth2_custom' } },
		customAuth: {
			getInstallUrl: vi.fn(),
			handleCallback: vi.fn(),
			getAccessToken: vi.fn(),
		},
	}),
}))

import {
	PersistentGithub401Error,
	performGithubWrite,
} from '../../../../lib/integrations/providers/github/write-safe'

interface MockDb {
	db: Parameters<typeof performGithubWrite>[0]
	insertedEvents: Array<Record<string, unknown>>
	insertedNotifications: Array<Record<string, unknown>>
	updatedSets: Array<Record<string, unknown>>
	transactionCalls: number
	insertedEventId: number
}

/**
 * Minimal Drizzle-shaped mock. Select on `objects` returns a fixture row so
 * the metadata-merge branch runs; insert on `events` returns a synthetic id
 * so the notifications INSERT can reference it.
 */
function createMockDb(options?: {
	existingObjectMetadata?: Record<string, unknown> | null
	existingObjectMissing?: boolean
}): MockDb {
	const insertedEvents: Array<Record<string, unknown>> = []
	const insertedNotifications: Array<Record<string, unknown>> = []
	const updatedSets: Array<Record<string, unknown>> = []
	const insertedEventId = 987654
	let transactionCalls = 0

	// Both events and notifications go through the same insert().values(...) chain.
	// The escalation code differentiates by shape: it calls insert(events).values({...single row}).returning()
	// and insert(notifications).values([...rows]) without .returning(). Route on the values shape
	// so the mock doesn't depend on internal pgTable identity.
	const mockInsert = vi.fn().mockReturnValue({
		values: vi
			.fn()
			.mockImplementation((values: Record<string, unknown> | Array<Record<string, unknown>>) => {
				if (Array.isArray(values)) {
					for (const row of values) insertedNotifications.push(row)
					return Promise.resolve()
				}
				insertedEvents.push(values)
				// Attach .returning() onto the Promise so awaiting-with-destructuring works either way.
				return Object.assign(Promise.resolve([{ id: insertedEventId }]), {
					returning: vi.fn().mockResolvedValue([{ id: insertedEventId }]),
				})
			}),
	})

	const mockSelect = vi.fn().mockReturnValue({
		from: vi.fn().mockReturnValue({
			where: vi.fn().mockReturnValue({
				limit: vi.fn().mockImplementation(async () => {
					if (options?.existingObjectMissing) return []
					return [{ metadata: options?.existingObjectMetadata ?? null }]
				}),
			}),
		}),
	})

	const mockUpdate = vi.fn().mockReturnValue({
		set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
			updatedSets.push(values)
			return { where: vi.fn().mockResolvedValue(undefined) }
		}),
	})

	const db = {
		select: mockSelect,
		update: mockUpdate,
		insert: mockInsert,
		transaction: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
			transactionCalls += 1
			return cb(db)
		}),
	} as unknown as Parameters<typeof performGithubWrite>[0]

	return {
		db,
		insertedEvents,
		insertedNotifications,
		updatedSets,
		get transactionCalls() {
			return transactionCalls
		},
		insertedEventId,
	} as MockDb
}

function makeResponse(status: number, body = ''): Response {
	return new Response(body, { status })
}

describe('performGithubWrite', () => {
	const fetchMock = vi.fn()

	beforeEach(() => {
		mockGetValidToken.mockReset()
		fetchMock.mockReset()
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('returns the response and mints once on the happy path', async () => {
		const { db } = createMockDb()
		mockGetValidToken.mockResolvedValue('gh-token-1')
		fetchMock.mockResolvedValueOnce(makeResponse(200, '{"ok":true}'))

		const res = await performGithubWrite(db, 'integration-1', {
			url: 'https://api.github.com/repos/o/r/pulls/1/merge',
			method: 'PUT',
			body: { merge_method: 'squash' },
		})

		expect(res.status).toBe(200)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(mockGetValidToken).toHaveBeenCalledTimes(1)

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://api.github.com/repos/o/r/pulls/1/merge')
		expect(init.method).toBe('PUT')
		const headers = init.headers as Record<string, string>
		expect(headers.Authorization).toBe('Bearer gh-token-1')
		expect(headers['Content-Type']).toBe('application/json')
		expect(init.body).toBe('{"merge_method":"squash"}')
	})

	it('re-mints and retries exactly once on 401, returning the retry response', async () => {
		const { db } = createMockDb()
		mockGetValidToken.mockResolvedValueOnce('stale-token').mockResolvedValueOnce('fresh-token')
		fetchMock
			.mockResolvedValueOnce(makeResponse(401, 'Bad credentials'))
			.mockResolvedValueOnce(makeResponse(200, '{"merged":true}'))

		const res = await performGithubWrite(db, 'integration-1', {
			url: 'https://api.github.com/repos/o/r/pulls/1/merge',
			method: 'PUT',
			body: { merge_method: 'squash' },
		})

		expect(res.status).toBe(200)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(mockGetValidToken).toHaveBeenCalledTimes(2)

		const firstAuth = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<
			string,
			string
		>
		const secondAuth = (fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<
			string,
			string
		>
		expect(firstAuth.Authorization).toBe('Bearer stale-token')
		expect(secondAuth.Authorization).toBe('Bearer fresh-token')
	})

	it('escalates and throws PersistentGithub401Error when the retry also 401s', async () => {
		const mock = createMockDb({ existingObjectMetadata: { previous_flag: 'kept' } })
		mockGetValidToken.mockResolvedValueOnce('stale-token').mockResolvedValueOnce('also-stale-token')
		fetchMock
			.mockResolvedValueOnce(makeResponse(401, 'Bad credentials'))
			.mockResolvedValueOnce(makeResponse(401, 'still bad credentials'))

		await expect(
			performGithubWrite(
				mock.db,
				'integration-1',
				{
					url: 'https://api.github.com/repos/o/r/pulls/1/merge',
					method: 'PUT',
					body: { merge_method: 'squash' },
				},
				{
					workspaceId: 'ws-1',
					entityId: 'task-1',
					actorId: 'bot-1',
					mentions: ['human-1', 'human-2'],
				},
			),
		).rejects.toBeInstanceOf(PersistentGithub401Error)

		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(mockGetValidToken).toHaveBeenCalledTimes(2)

		// One transaction (the escalation).
		expect(mock.transactionCalls).toBe(1)

		// Metadata merge preserves prior flags and adds the failure flag.
		expect(mock.updatedSets.length).toBe(1)
		const updatedMetadata = mock.updatedSets[0]?.metadata as Record<string, unknown>
		expect(updatedMetadata.previous_flag).toBe('kept')
		expect(updatedMetadata.github_write_failed).toBe(true)
		expect(typeof updatedMetadata.github_write_failed_at).toBe('string')

		// Escalation comment inserted with @mentions attached.
		expect(mock.insertedEvents.length).toBe(1)
		const commentEvent = mock.insertedEvents[0] as {
			action: string
			entityType: string
			entityId: string
			data: { content: string; mentions: string[] }
		}
		expect(commentEvent.action).toBe('commented')
		expect(commentEvent.entityType).toBe('object')
		expect(commentEvent.entityId).toBe('task-1')
		expect(commentEvent.data.mentions).toEqual(['human-1', 'human-2'])
		expect(commentEvent.data.content).toContain('401')
		expect(commentEvent.data.content).toContain(
			'PUT https://api.github.com/repos/o/r/pulls/1/merge',
		)

		// One needs_input notification per @mentioned human, all referencing the
		// escalation comment id so the UI can deep-link the notification to it.
		expect(mock.insertedNotifications.length).toBe(2)
		for (const notification of mock.insertedNotifications) {
			expect(notification.type).toBe('needs_input')
			expect(notification.status).toBe('pending')
			expect(notification.objectId).toBe('task-1')
			expect(notification.sourceActorId).toBe('bot-1')
			const metadata = notification.metadata as Record<string, unknown>
			expect(metadata.reason).toBe('github_write_persistent_401')
			expect(metadata.commentEventId).toBe(mock.insertedEventId)
		}
		expect(mock.insertedNotifications.map((n) => n.targetActorId)).toEqual(['human-1', 'human-2'])
	})

	it('throws without touching the DB when escalation target is omitted', async () => {
		const mock = createMockDb()
		mockGetValidToken.mockResolvedValue('stale-token')
		fetchMock.mockResolvedValueOnce(makeResponse(401)).mockResolvedValueOnce(makeResponse(401))

		await expect(
			performGithubWrite(mock.db, 'integration-1', {
				url: 'https://api.github.com/repos/o/r/pulls/1/merge',
				method: 'PUT',
			}),
		).rejects.toBeInstanceOf(PersistentGithub401Error)

		expect(mock.transactionCalls).toBe(0)
		expect(mock.insertedEvents.length).toBe(0)
		expect(mock.insertedNotifications.length).toBe(0)
	})

	it('does not retry on non-401 responses', async () => {
		const { db } = createMockDb()
		mockGetValidToken.mockResolvedValue('gh-token-1')
		fetchMock.mockResolvedValueOnce(makeResponse(422, 'validation error'))

		const res = await performGithubWrite(db, 'integration-1', {
			url: 'https://api.github.com/repos/o/r/pulls/1/merge',
			method: 'PUT',
			body: { merge_method: 'squash' },
		})

		expect(res.status).toBe(422)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(mockGetValidToken).toHaveBeenCalledTimes(1)
	})

	it('does not retry on 500 errors either', async () => {
		const { db } = createMockDb()
		mockGetValidToken.mockResolvedValue('gh-token-1')
		fetchMock.mockResolvedValueOnce(makeResponse(500, 'server exploded'))

		const res = await performGithubWrite(db, 'integration-1', {
			url: 'https://api.github.com/repos/o/r/pulls/1/merge',
			method: 'PUT',
		})

		expect(res.status).toBe(500)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('escalates without a metadata update when the target object is missing', async () => {
		const mock = createMockDb({ existingObjectMissing: true })
		mockGetValidToken.mockResolvedValue('stale-token')
		fetchMock.mockResolvedValueOnce(makeResponse(401)).mockResolvedValueOnce(makeResponse(401))

		await expect(
			performGithubWrite(
				mock.db,
				'integration-1',
				{
					url: 'https://api.github.com/repos/o/r/pulls/1/merge',
					method: 'PUT',
				},
				{
					workspaceId: 'ws-1',
					entityId: 'missing-task',
					actorId: 'bot-1',
					mentions: ['human-1'],
				},
			),
		).rejects.toBeInstanceOf(PersistentGithub401Error)

		expect(mock.updatedSets.length).toBe(0)
		expect(mock.insertedEvents.length).toBe(1)
		expect(mock.insertedNotifications.length).toBe(1)
	})
})
