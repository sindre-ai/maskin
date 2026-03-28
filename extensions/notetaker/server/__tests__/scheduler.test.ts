import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock calendar and recall services
vi.mock('../services/calendar.js', () => ({
	fetchUpcomingMeetings: vi.fn(),
}))

vi.mock('../services/recall.js', () => ({
	createBot: vi.fn(),
}))

import { fetchUpcomingMeetings } from '../services/calendar.js'
import { createBot } from '../services/recall.js'
import { syncCalendarsForWorkspace } from '../services/scheduler.js'
import type { GetTokenFn } from '../services/scheduler.js'

const mockFetchMeetings = vi.mocked(fetchUpcomingMeetings)
const mockCreateBot = vi.mocked(createBot)

// Minimal mock DB that tracks inserts and selects
function createMockDb() {
	const inserted: unknown[] = []
	let selectResult: unknown[] = []

	const mockReturning = () => [
		{
			id: `meeting-${inserted.length}`,
			workspaceId: 'ws-1',
			type: 'meeting',
			metadata: inserted.at(-1),
		},
	]

	const db = {
		insert: vi.fn().mockReturnValue({
			values: vi.fn().mockImplementation((val: unknown) => {
				inserted.push(val)
				return { returning: vi.fn().mockReturnValue(mockReturning()) }
			}),
		}),
		update: vi.fn().mockReturnValue({
			set: vi.fn().mockReturnValue({
				where: vi.fn().mockReturnValue({ returning: vi.fn().mockReturnValue([]) }),
			}),
		}),
		select: vi.fn().mockReturnValue({
			from: vi.fn().mockReturnValue({
				where: vi.fn().mockReturnValue(selectResult),
			}),
		}),
		_setSelectResult(result: unknown[]) {
			selectResult = result
			db.select.mockReturnValue({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue(selectResult),
				}),
			})
		},
		_getInserted() {
			return inserted
		},
	}

	return db
}

describe('syncCalendarsForWorkspace', () => {
	const mockGetToken: GetTokenFn = vi.fn().mockResolvedValue('test-access-token')

	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('creates meeting objects and dispatches bots for meetings with video links', async () => {
		mockFetchMeetings.mockResolvedValueOnce([
			{
				id: 'cal-event-1',
				title: 'Team Standup',
				start: '2026-03-28T10:00:00Z',
				end: '2026-03-28T10:30:00Z',
				videoLink: 'https://meet.google.com/abc-def',
				attendees: ['alice@test.com'],
				organizer: 'alice@test.com',
			},
		])

		const mockDb = createMockDb()
		// No existing meetings (dedup returns empty)
		mockDb._setSelectResult([])

		mockCreateBot.mockResolvedValueOnce({
			id: 'bot-1',
			meeting_url: 'https://meet.google.com/abc-def',
			status_changes: [],
			video_url: null,
			bot_name: 'Maskin Notetaker',
		})

		const env = { db: mockDb } as never

		const result = await syncCalendarsForWorkspace(
			'ws-1',
			[{ id: 'int-1', workspaceId: 'ws-1', provider: 'google-calendar', createdBy: 'actor-1' }],
			mockGetToken,
			env,
		)

		expect(result.created).toBe(1)
		expect(result.skipped).toBe(0)
		expect(mockGetToken).toHaveBeenCalledWith('int-1', 'google-calendar')
		expect(mockFetchMeetings).toHaveBeenCalledWith('test-access-token', 'google-calendar', {
			lookaheadMinutes: 30,
		})
		expect(mockCreateBot).toHaveBeenCalledWith('https://meet.google.com/abc-def', {
			botName: 'Maskin Notetaker',
			joinAt: '2026-03-28T10:00:00Z',
		})
	})

	it('skips meetings without video links', async () => {
		mockFetchMeetings.mockResolvedValueOnce([
			{
				id: 'cal-event-2',
				title: 'Lunch',
				start: '2026-03-28T12:00:00Z',
				end: '2026-03-28T13:00:00Z',
				videoLink: null,
				attendees: [],
				organizer: 'me@test.com',
			},
		])

		const mockDb = createMockDb()
		const env = { db: mockDb } as never

		const result = await syncCalendarsForWorkspace(
			'ws-1',
			[{ id: 'int-1', workspaceId: 'ws-1', provider: 'google-calendar', createdBy: 'actor-1' }],
			mockGetToken,
			env,
		)

		expect(result.created).toBe(0)
		expect(mockCreateBot).not.toHaveBeenCalled()
	})

	it('skips already-scheduled meetings (deduplication)', async () => {
		mockFetchMeetings.mockResolvedValueOnce([
			{
				id: 'cal-event-3',
				title: 'Recurring Meeting',
				start: '2026-03-28T14:00:00Z',
				end: '2026-03-28T15:00:00Z',
				videoLink: 'https://zoom.us/j/123',
				attendees: [],
				organizer: 'me@test.com',
			},
		])

		const mockDb = createMockDb()
		// Existing meeting with same calendar_event_id
		mockDb._setSelectResult([{ id: 'existing-1', metadata: { calendar_event_id: 'cal-event-3' } }])

		const env = { db: mockDb } as never

		const result = await syncCalendarsForWorkspace(
			'ws-1',
			[{ id: 'int-1', workspaceId: 'ws-1', provider: 'google-calendar', createdBy: 'actor-1' }],
			mockGetToken,
			env,
		)

		expect(result.skipped).toBe(1)
		expect(result.created).toBe(0)
		expect(mockCreateBot).not.toHaveBeenCalled()
	})

	it('continues on calendar fetch failure', async () => {
		mockFetchMeetings.mockRejectedValueOnce(new Error('API error'))

		const mockDb = createMockDb()
		const env = { db: mockDb } as never

		const result = await syncCalendarsForWorkspace(
			'ws-1',
			[{ id: 'int-1', workspaceId: 'ws-1', provider: 'google-calendar', createdBy: 'actor-1' }],
			mockGetToken,
			env,
		)

		expect(result.created).toBe(0)
		expect(result.skipped).toBe(0)
	})
})
