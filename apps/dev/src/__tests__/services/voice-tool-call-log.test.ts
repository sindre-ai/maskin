import type { Database } from '@maskin/db'
import { describe, expect, it, vi } from 'vitest'
import { recordVoiceToolCallLog } from '../../services/voice-tool-call-log'

const input = {
	voiceSessionId: '5b9e3a4c-bd6f-4143-8e80-7c2f9d13a664',
	workspaceId: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
	callId: 'call_1',
	startedAt: new Date('2026-10-28T10:00:00Z'),
	toolName: 'get_objects',
	args: { ids: ['abc'], token: 'secret' },
	success: false,
	errorCode: 'voice_tool_failed',
	errorMessage: 'invalid id',
	outputChars: 10,
	outputTruncated: false,
	latencyMs: 42,
	output: '{"error":"invalid id"}',
}

describe('recordVoiceToolCallLog', () => {
	it('writes the redacted row', async () => {
		const values = vi.fn().mockResolvedValue(undefined)
		const db = { insert: () => ({ values }) } as unknown as Database
		await recordVoiceToolCallLog(db, input)
		expect(values).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: 'get_objects',
				argsSummary: { ids: ['abc'], token: '[redacted]' },
				errorMessage: 'invalid id',
				outputPreview: '{"error":"invalid id"}',
			}),
		)
	})

	it('resolves when the insert rejects', async () => {
		const db = {
			insert: () => ({ values: () => Promise.reject(new Error('connection lost')) }),
		} as unknown as Database
		await expect(recordVoiceToolCallLog(db, input)).resolves.toBeUndefined()
	})

	it('resolves when the db throws synchronously', async () => {
		const db = {
			insert: () => {
				throw new Error('pool closed')
			},
		} as unknown as Database
		await expect(recordVoiceToolCallLog(db, input)).resolves.toBeUndefined()
	})
})
