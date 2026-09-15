import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../../lib/integrations/providers/google-meet/token', () => ({
	GOOGLE_MEET_PROVIDER: 'google-meet',
	getGoogleMeetAccessToken: vi.fn(),
}))

vi.mock('../../../../lib/integrations/providers/google-meet/idempotency', async () => {
	const actual = await vi.importActual<
		typeof import('../../../../lib/integrations/providers/google-meet/idempotency')
	>('../../../../lib/integrations/providers/google-meet/idempotency')
	return {
		...actual,
		readIdempotency: vi.fn(),
		recordIdempotency: vi.fn(),
	}
})

import type { GoogleMeetClient } from '../../../../lib/integrations/providers/google-meet/client'
import { MeetError } from '../../../../lib/integrations/providers/google-meet/errors'
import {
	readIdempotency,
	recordIdempotency,
} from '../../../../lib/integrations/providers/google-meet/idempotency'
import {
	type CreateMeetBackedEventContext,
	type OperationsContext,
	createMeetBackedEvent,
	createSpace,
} from '../../../../lib/integrations/providers/google-meet/operations'
import { getGoogleMeetAccessToken } from '../../../../lib/integrations/providers/google-meet/token'

const workspaceId = 'ws-1'
const callerActorId = '11111111-1111-1111-1111-111111111111'

function fakeClient(overrides: Partial<GoogleMeetClient> = {}): GoogleMeetClient {
	return {
		createSpace: vi.fn(async () => ({
			name: 'spaces/xyz',
			meetingUri: 'https://meet.google.com/abc-defg-hij',
			meetingCode: 'abc-defg-hij',
			config: {},
		})),
		insertCalendarEvent: vi.fn(async () => ({
			id: 'event-1',
			hangoutLink: 'https://meet.google.com/abc-defg-hij',
			conferenceData: {
				conferenceId: 'abc-defg-hij',
				entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }],
			},
		})),
		...overrides,
	}
}

function baseCtx(client: GoogleMeetClient): OperationsContext {
	return {
		db: {} as OperationsContext['db'],
		workspaceId,
		callerActorId,
		client,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	;(getGoogleMeetAccessToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
		accessToken: 'ya29.fake',
		integrationId: 'int-1',
	})
	;(readIdempotency as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null)
	;(recordIdempotency as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_db, p) => ({
		inserted: true,
		row: { spaceName: p.spaceName, meetingCode: p.meetingCode, meetingUri: p.meetingUri },
	}))
})

describe('createSpace', () => {
	it('provisions a space when no cached row exists and records the idempotency ledger entry', async () => {
		const client = fakeClient()
		const ctx = baseCtx(client)

		const out = await createSpace(ctx, { purpose: 'Sebk demo w/ Acme' })

		expect(out.space_name).toBe('spaces/xyz')
		expect(out.meeting_code).toBe('abc-defg-hij')
		expect(out.meeting_uri).toBe('https://meet.google.com/abc-defg-hij')
		expect(out.idempotent_replay).toBe(false)

		expect(client.createSpace).toHaveBeenCalledTimes(1)
		expect(recordIdempotency).toHaveBeenCalledTimes(1)
		expect(readIdempotency).toHaveBeenCalledTimes(1)
	})

	it('replays a cached space on second call with the same key — Meet API is not touched', async () => {
		const client = fakeClient()
		const ctx = baseCtx(client)
		;(readIdempotency as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			spaceName: 'spaces/cached',
			meetingCode: 'cac-hedd-key',
			meetingUri: 'https://meet.google.com/cac-hedd-key',
		})

		const out = await createSpace(ctx, {
			purpose: 'Sebk demo w/ Acme',
			idempotency_key: 'explicit-key',
		})

		expect(out.space_name).toBe('spaces/cached')
		expect(out.idempotent_replay).toBe(true)
		expect(client.createSpace).not.toHaveBeenCalled()
		expect(recordIdempotency).not.toHaveBeenCalled()
	})

	it('replays the winner on race (record → not inserted → returned row)', async () => {
		const client = fakeClient()
		const ctx = baseCtx(client)
		;(recordIdempotency as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			inserted: false,
			row: {
				spaceName: 'spaces/winner',
				meetingCode: 'win-nner-xyz',
				meetingUri: 'https://meet.google.com/win-nner-xyz',
			},
		})

		const out = await createSpace(ctx, { purpose: 'demo' })

		// Our own provisional space was leaked (Meet API was called) but the
		// tool returned the winner's space so the caller sees a single stable
		// answer across concurrent invocations.
		expect(client.createSpace).toHaveBeenCalledTimes(1)
		expect(out.space_name).toBe('spaces/winner')
		expect(out.idempotent_replay).toBe(true)
	})

	it('passes moderation + recording + transcription config through to spaces.create', async () => {
		const client = fakeClient()
		const ctx = baseCtx(client)

		await createSpace(ctx, {
			purpose: 'moderated demo',
			access_type: 'RESTRICTED',
			entry_point_access: 'CREATOR_APP_ONLY',
			moderation: 'ON',
			recording: { auto_start: true },
			transcription: { auto_start: true },
			attendance_report: { generate: true },
		})

		const args = (client.createSpace as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]
		expect(args).toMatchObject({
			config: {
				accessType: 'RESTRICTED',
				entryPointAccess: 'CREATOR_APP_ONLY',
				moderation: 'ON',
				attendanceReportGenerationType: 'GENERATE_REPORT',
				artifactConfig: {
					recordingConfig: { autoRecordingGeneration: 'ON' },
					transcriptionConfig: { autoTranscriptionGeneration: 'ON' },
				},
			},
		})
	})

	it('omits config entirely when no moderation flags are set — spaces.create body is `{}`', async () => {
		const client = fakeClient()
		const ctx = baseCtx(client)

		await createSpace(ctx, { purpose: 'defaults only' })

		const args = (client.createSpace as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]
		expect(args).toEqual({})
	})

	it('bubbles MeetError from the Google client verbatim (RECONSENT_REQUIRED on 403 with missing scope)', async () => {
		const client = fakeClient({
			createSpace: vi.fn(async () => {
				throw new MeetError({
					code: 'RECONSENT_REQUIRED',
					message: 'meetings.space.created not granted',
					provider_status: 403,
				})
			}),
		})
		const ctx = baseCtx(client)

		await expect(createSpace(ctx, { purpose: 'demo' })).rejects.toMatchObject({
			name: 'MeetError',
			code: 'RECONSENT_REQUIRED',
		})
		expect(recordIdempotency).not.toHaveBeenCalled()
	})

	it('surfaces MEET_REQUIRES_WORKSPACE unchanged when Google flags a consumer account', async () => {
		const client = fakeClient({
			createSpace: vi.fn(async () => {
				throw new MeetError({
					code: 'MEET_REQUIRES_WORKSPACE',
					message: 'consumer account',
					provider_status: 403,
				})
			}),
		})
		const ctx = baseCtx(client)

		await expect(createSpace(ctx, { purpose: 'demo' })).rejects.toMatchObject({
			name: 'MeetError',
			code: 'MEET_REQUIRES_WORKSPACE',
		})
	})

	it('uses explicit actor_id in the token lookup (not the caller) when the caller passes it', async () => {
		const client = fakeClient()
		const ctx = baseCtx(client)
		const otherActor = '99999999-9999-9999-9999-999999999999'

		await createSpace(ctx, { purpose: 'p', actor_id: otherActor })

		expect(getGoogleMeetAccessToken).toHaveBeenCalledWith(ctx.db, workspaceId, otherActor)
	})
})

describe('createMeetBackedEvent', () => {
	const input = {
		summary: 'Product review',
		start: { date_time: '2026-09-15T15:00:00+02:00', time_zone: 'Europe/Copenhagen' },
		end: { date_time: '2026-09-15T16:00:00+02:00', time_zone: 'Europe/Copenhagen' },
	}

	it('sends conferenceDataVersion=1 + a deterministic requestId, returns the Meet uri + space name', async () => {
		const client = fakeClient()
		const ctx = baseCtx(client)

		const out = await createMeetBackedEvent(ctx, input)

		expect(out.meet_uri).toBe('https://meet.google.com/abc-defg-hij')
		expect(out.meet_space_name).toBe('spaces/abc-defg-hij')
		expect(out.request_id).toMatch(/^[0-9a-f]{64}$/)

		const call = (client.insertCalendarEvent as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]
		expect(call.calendarId).toBe('primary')
		expect(call.body).toMatchObject({
			summary: 'Product review',
			start: { dateTime: '2026-09-15T15:00:00+02:00', timeZone: 'Europe/Copenhagen' },
			end: { dateTime: '2026-09-15T16:00:00+02:00', timeZone: 'Europe/Copenhagen' },
			conferenceData: {
				createRequest: {
					requestId: expect.stringMatching(/^[0-9a-f]{64}$/),
					conferenceSolutionKey: { type: 'hangoutsMeet' },
				},
			},
		})
	})

	it('honours a caller-supplied request_id verbatim (Google-native replay contract)', async () => {
		const client = fakeClient()
		const ctx = baseCtx(client)

		const out = await createMeetBackedEvent(ctx, {
			...input,
			request_id: 'caller-supplied-key-1',
		})

		expect(out.request_id).toBe('caller-supplied-key-1')
		const call = (client.insertCalendarEvent as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]
		expect(call.body).toMatchObject({
			conferenceData: { createRequest: { requestId: 'caller-supplied-key-1' } },
		})
	})

	it('writes attendees + description when supplied', async () => {
		const client = fakeClient()
		const ctx = baseCtx(client)

		await createMeetBackedEvent(ctx, {
			...input,
			description: 'agenda',
			attendees: [{ email: 'a@x.com' }, { email: 'b@x.com', optional: true }],
			send_updates: 'externalOnly',
		})

		const call = (client.insertCalendarEvent as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]
		expect(call.sendUpdates).toBe('externalOnly')
		expect(call.body).toMatchObject({
			description: 'agenda',
			attendees: [{ email: 'a@x.com' }, { email: 'b@x.com', optional: true }],
		})
	})

	it('throws PROVIDER_ERROR when GCal succeeds but no conferenceData is attached (bug ac295f51 mode)', async () => {
		const client = fakeClient({
			insertCalendarEvent: vi.fn(async () => ({
				id: 'event-1',
				// hangoutLink absent, conferenceData absent — GCal accepted the event
				// but dropped the createRequest.
			})),
		})
		const ctx = baseCtx(client)

		await expect(createMeetBackedEvent(ctx, input)).rejects.toMatchObject({
			name: 'MeetError',
			code: 'PROVIDER_ERROR',
			providerStatus: 200,
		})
	})

	it('bubbles MEET_REQUIRES_WORKSPACE unchanged from the client', async () => {
		const client = fakeClient({
			insertCalendarEvent: vi.fn(async () => {
				throw new MeetError({
					code: 'MEET_REQUIRES_WORKSPACE',
					message: 'consumer account',
					provider_status: 403,
				})
			}),
		})
		const ctx = baseCtx(client)

		await expect(createMeetBackedEvent(ctx, input)).rejects.toMatchObject({
			name: 'MeetError',
			code: 'MEET_REQUIRES_WORKSPACE',
		})
	})

	it('bubbles RECONSENT_REQUIRED unchanged from the client', async () => {
		const client = fakeClient({
			insertCalendarEvent: vi.fn(async () => {
				throw new MeetError({
					code: 'RECONSENT_REQUIRED',
					message: 'scope missing',
					provider_status: 403,
				})
			}),
		})
		const ctx = baseCtx(client)

		await expect(createMeetBackedEvent(ctx, input)).rejects.toMatchObject({
			name: 'MeetError',
			code: 'RECONSENT_REQUIRED',
		})
	})

	it('bubbles NOT_FOUND when the calendar id is invalid', async () => {
		const client = fakeClient({
			insertCalendarEvent: vi.fn(async () => {
				throw new MeetError({
					code: 'NOT_FOUND',
					message: 'calendar missing',
					provider_status: 404,
				})
			}),
		})
		const ctx = baseCtx(client)

		await expect(
			createMeetBackedEvent(ctx, { ...input, calendar_id: 'does-not-exist@x.com' }),
		).rejects.toMatchObject({ name: 'MeetError', code: 'NOT_FOUND' })
	})

	it('calls the metadataWriter with the extracted space_name when linked_meeting_object_id is provided', async () => {
		const client = fakeClient()
		const writer = vi.fn(async () => undefined)
		const ctx: CreateMeetBackedEventContext = {
			...baseCtx(client),
			metadataWriter: writer,
		}
		const linkedId = '33333333-3333-3333-3333-333333333333'

		const out = await createMeetBackedEvent(ctx, {
			...input,
			linked_meeting_object_id: linkedId,
		})

		expect(writer).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId,
				meetingObjectId: linkedId,
				spaceName: 'spaces/abc-defg-hij',
			}),
		)
		expect(out.linked_meeting_metadata_written).toBe(true)
	})

	it('logs but does not throw when the metadata writeback fails — the calendar event is still valid', async () => {
		const client = fakeClient()
		const writer = vi.fn(async () => {
			throw new Error('meeting object not found')
		})
		const ctx: CreateMeetBackedEventContext = {
			...baseCtx(client),
			metadataWriter: writer,
		}

		const out = await createMeetBackedEvent(ctx, {
			...input,
			linked_meeting_object_id: '33333333-3333-3333-3333-333333333333',
		})

		expect(out.meet_uri).toBe('https://meet.google.com/abc-defg-hij')
		expect(out.linked_meeting_metadata_written).toBe(false)
	})

	it('honours explicit actor_id in the token lookup', async () => {
		const client = fakeClient()
		const ctx = baseCtx(client)
		const otherActor = '99999999-9999-9999-9999-999999999999'

		await createMeetBackedEvent(ctx, { ...input, actor_id: otherActor })

		expect(getGoogleMeetAccessToken).toHaveBeenCalledWith(ctx.db, workspaceId, otherActor)
	})
})
