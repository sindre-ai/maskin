import { beforeEach, describe, expect, it, vi } from 'vitest'

const reconcileSpy = vi.hoisted(() => vi.fn())
const writeMetaSpy = vi.hoisted(() => vi.fn())
const tokenSpy = vi.hoisted(() => vi.fn())

vi.mock('../../lib/integrations/providers/google-meet/watch', () => ({
	reconcileMeetingArtefacts: reconcileSpy,
}))
vi.mock('../../lib/integrations/providers/google-meet/meeting-metadata', () => ({
	writeMeetingMetadata: writeMetaSpy,
}))
vi.mock('../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: class {
		getValidToken = tokenSpy
	},
}))
vi.mock('../../lib/integrations/registry', () => ({ getProvider: vi.fn() }))

import { MeetTranscriptReconciler } from '../../services/meet-transcript-reconciler'

const HOUR = 60 * 60 * 1000

interface FakeMeeting {
	id: string
	workspaceId: string
	metadata: Record<string, unknown>
}

// First select() lists meetings; second select() is the integrations row lookup.
function makeFakeDb(meetings: FakeMeeting[]) {
	let call = 0
	return {
		select: () => ({
			from: () => ({
				where: () => {
					call++
					if (call === 1) return Promise.resolve(meetings)
					return { limit: () => Promise.resolve([{ id: 'integration-1' }]) }
				},
			}),
		}),
	} as never
}

function meetingAgedHours(hours: number, extra: Record<string, unknown>): FakeMeeting {
	return {
		id: 'm1',
		workspaceId: 'ws1',
		metadata: { meeting_date: new Date(Date.now() - hours * HOUR).toISOString(), ...extra },
	}
}

async function runTick(reconciler: MeetTranscriptReconciler) {
	// @ts-expect-error access private method for testing
	await reconciler.tick()
}

describe('MeetTranscriptReconciler', () => {
	beforeEach(() => {
		reconcileSpy.mockReset()
		writeMetaSpy.mockReset().mockResolvedValue(undefined)
		tokenSpy.mockReset().mockResolvedValue('tok')
	})

	it('marks a meeting unavailable when the record has no transcript after the window', async () => {
		reconcileSpy.mockResolvedValue(false)
		const db = makeFakeDb([meetingAgedHours(71, { google_meet_space_name: 'spaces/s1' })])
		await runTick(new MeetTranscriptReconciler(db, {} as never))
		expect(writeMetaSpy).toHaveBeenCalledWith(
			db,
			'm1',
			expect.objectContaining({ transcript_status: 'unavailable', artefact_state: 'not_recorded' }),
		)
	})

	it('only records a poll while the meeting is still inside the window', async () => {
		reconcileSpy.mockResolvedValue(false)
		const db = makeFakeDb([meetingAgedHours(5, { google_meet_space_name: 'spaces/s1' })])
		await runTick(new MeetTranscriptReconciler(db, {} as never))
		expect(writeMetaSpy).toHaveBeenCalledTimes(1)
		expect(writeMetaSpy.mock.calls[0][2]).not.toHaveProperty('transcript_status')
	})

	it('sweeps an agent-created meeting that only has a conference record name', async () => {
		reconcileSpy.mockResolvedValue(true)
		const db = makeFakeDb([
			meetingAgedHours(5, { google_meet_conference_record_name: 'conferenceRecords/abc' }),
		])
		await runTick(new MeetTranscriptReconciler(db, {} as never))
		expect(reconcileSpy).toHaveBeenCalledWith(
			db,
			'tok',
			'ws1',
			'm1',
			undefined,
			'conferenceRecords/abc',
			expect.anything(),
		)
	})
})
