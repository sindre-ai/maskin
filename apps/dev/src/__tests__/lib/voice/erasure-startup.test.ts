import type { Database } from '@maskin/db'
import type { StorageProvider } from '@maskin/storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { VoiceDialerJob } from '../../../jobs/voice-dialer'
import { VoiceRetentionSweepJob } from '../../../jobs/voice-retention-sweep'
import { logger } from '../../../lib/logger'

// What index.ts does at startup for the voice module: build the dialer job and the retention
// sweep job. The aggregate PR reaches prod before VOICE_ERASURE_MARKER_KEY can be set there,
// with the dialer flag off, so a missing or short key must not stop either from being built.
describe('server start with VOICE_ERASURE_MARKER_KEY unset', () => {
	const saved = process.env.VOICE_ERASURE_MARKER_KEY

	beforeEach(() => {
		Reflect.deleteProperty(process.env, 'VOICE_ERASURE_MARKER_KEY')
		vi.mocked(logger.warn).mockClear()
		vi.mocked(logger.error).mockClear()
	})

	afterEach(() => {
		if (saved === undefined) Reflect.deleteProperty(process.env, 'VOICE_ERASURE_MARKER_KEY')
		else process.env.VOICE_ERASURE_MARKER_KEY = saved
	})

	it('builds both voice jobs, logs a warning for the dialer and logs no error', () => {
		const db = {} as Database
		expect(() => new VoiceDialerJob(db, {})).not.toThrow()
		expect(() => new VoiceRetentionSweepJob(db, {} as StorageProvider)).not.toThrow()

		expect(logger.error).not.toHaveBeenCalled()
		expect(logger.warn).toHaveBeenCalledWith(
			'voice dialer: erased-contact check will refuse every dial',
			{ reason: 'VOICE_ERASURE_MARKER_KEY is not set' },
		)
	})

	it('builds both voice jobs with a key that is too short, without an error', () => {
		const db = {} as Database
		process.env.VOICE_ERASURE_MARKER_KEY = 'too-short'
		expect(() => new VoiceDialerJob(db, { VOICE_ERASURE_MARKER_KEY: 'too-short' })).not.toThrow()
		expect(() => new VoiceRetentionSweepJob(db, {} as StorageProvider)).not.toThrow()
		expect(logger.error).not.toHaveBeenCalled()
	})

	it('builds both voice jobs quietly when the key is set', () => {
		const key = 'test-erasure-marker-key-0123456789-abcdef'
		process.env.VOICE_ERASURE_MARKER_KEY = key
		const db = {} as Database
		new VoiceDialerJob(db, { VOICE_ERASURE_MARKER_KEY: key })
		new VoiceRetentionSweepJob(db, {} as StorageProvider)
		expect(logger.warn).not.toHaveBeenCalledWith(
			'voice dialer: erased-contact check will refuse every dial',
			expect.anything(),
		)
		expect(logger.error).not.toHaveBeenCalled()
	})
})
