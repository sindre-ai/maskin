import { beforeEach, describe, expect, it, vi } from 'vitest'

const callGoogleApiSpy = vi.hoisted(() => vi.fn())
const writeMetaSpy = vi.hoisted(() => vi.fn())

vi.mock('../../lib/integrations/providers/google-meet/client', () => ({
	callGoogleApi: callGoogleApiSpy,
}))
vi.mock('../../lib/integrations/providers/google-meet/meeting-metadata', () => ({
	writeMeetingMetadata: writeMetaSpy,
	attachTranscriptFile: vi.fn(),
	ensureMeetMeetingFields: vi.fn(),
}))
vi.mock('../../lib/integrations/providers/google-meet/synth-event', () => ({
	synthesizeMeetOnlyWrappedEvent: vi.fn(),
}))

import { reconcileMeetingArtefacts } from '../../lib/integrations/providers/google-meet/watch'

const db = {
	select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
} as never

describe('reconcileMeetingArtefacts', () => {
	beforeEach(() => {
		callGoogleApiSpy.mockReset()
		writeMetaSpy.mockReset().mockResolvedValue(undefined)
	})

	it('returns false when the conference record has no transcript', async () => {
		callGoogleApiSpy.mockImplementation(async (url: string) => {
			if (url.endsWith('/conferenceRecords')) {
				return { conferenceRecords: [{ name: 'conferenceRecords/abc' }] }
			}
			return {}
		})
		const wrote = await reconcileMeetingArtefacts(db, 'tok', 'ws', 'm1', 'spaces/s1', undefined, {})
		expect(wrote).toBe(false)
		expect(writeMetaSpy).not.toHaveBeenCalledWith(
			db,
			'm1',
			expect.objectContaining({ transcript_status: 'ready' }),
		)
	})

	it('looks the record up by name when the meeting has no space', async () => {
		callGoogleApiSpy.mockImplementation(async (url: string) => {
			if (url.endsWith('/transcripts'))
				return { transcripts: [{ name: 'conferenceRecords/abc/transcripts/t1' }] }
			return {}
		})
		const wrote = await reconcileMeetingArtefacts(
			db,
			'tok',
			'ws',
			'm1',
			undefined,
			'conferenceRecords/abc',
			{},
		)
		expect(wrote).toBe(true)
		expect(
			callGoogleApiSpy.mock.calls.some(([url]) => String(url).endsWith('/conferenceRecords')),
		).toBe(false)
		expect(writeMetaSpy).toHaveBeenCalledWith(
			db,
			'm1',
			expect.objectContaining({ transcript_status: 'ready', artefact_state: 'complete' }),
		)
	})

	it('returns false when the conference record name has no transcript', async () => {
		callGoogleApiSpy.mockResolvedValue({})
		const wrote = await reconcileMeetingArtefacts(
			db,
			'tok',
			'ws',
			'm1',
			undefined,
			'conferenceRecords/abc',
			{},
		)
		expect(wrote).toBe(false)
	})
})
