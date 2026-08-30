import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		triggers: {
			list: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
		},
	},
}))

vi.mock('@/lib/analytics', () => ({
	trackSlackTriggerResumedFromAutoPause: vi.fn(),
}))

import {
	AUTO_PAUSED_RESUME_LABEL,
	DEFAULT_RESUME_LABEL,
	readAutoPausedInfo,
	resumeTriggerLabel,
	useSlackAutoResume,
} from '@/hooks/use-slack-auto-resume'
import { trackSlackTriggerResumedFromAutoPause } from '@/lib/analytics'
import type { TriggerResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-42'

function buildTrigger(overrides: Partial<TriggerResponse> = {}): TriggerResponse {
	return {
		id: '00000000-0000-0000-0000-000000000101',
		workspaceId: '00000000-0000-0000-0000-000000000042',
		name: 'Alerts',
		type: 'event',
		config: null,
		actionPrompt: 'Do the thing',
		targetActorId: '00000000-0000-0000-0000-000000000003',
		enabled: false,
		metadata: null,
		createdBy: '00000000-0000-0000-0000-000000000004',
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

const autoPausedMetadata = {
	reason: 'slack_member_left' as const,
	channel_id: 'CKICKED',
	paused_at: '2026-08-30T14:00:00Z',
	previous_enabled: true,
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('resumeTriggerLabel', () => {
	it('branches to the auto-paused copy when metadata.auto_paused.reason matches', () => {
		const trigger = buildTrigger({ metadata: { auto_paused: autoPausedMetadata } })
		expect(resumeTriggerLabel(trigger)).toBe(AUTO_PAUSED_RESUME_LABEL)
	})

	it('falls back to the default "Resume trigger" copy for a plain user pause', () => {
		const trigger = buildTrigger({ metadata: null })
		expect(resumeTriggerLabel(trigger)).toBe(DEFAULT_RESUME_LABEL)
	})

	it('falls back when metadata carries a different auto_paused.reason (forward compat)', () => {
		const trigger = buildTrigger({
			metadata: { auto_paused: { ...autoPausedMetadata, reason: 'future_reason' } },
		})
		expect(resumeTriggerLabel(trigger)).toBe(DEFAULT_RESUME_LABEL)
	})

	it('falls back when trigger is undefined (hook-loading state)', () => {
		expect(resumeTriggerLabel(undefined)).toBe(DEFAULT_RESUME_LABEL)
	})
})

describe('readAutoPausedInfo', () => {
	it('rejects a malformed shape rather than crashing the caller', () => {
		const trigger = buildTrigger({
			metadata: {
				auto_paused: { reason: 'slack_member_left', channel_id: '', paused_at: 't' },
			},
		})
		expect(readAutoPausedInfo(trigger)).toBeNull()
	})
})

describe('useSlackAutoResume', () => {
	it('fires PostHog with time_since_pause_ms and PATCHes with enabled=true + clear_auto_paused=true', async () => {
		const updatedTrigger = buildTrigger({ enabled: true, metadata: null })
		vi.mocked(api.triggers.update).mockResolvedValue(updatedTrigger)

		const trigger = buildTrigger({
			metadata: { auto_paused: autoPausedMetadata },
		})

		// Freeze `now` so `time_since_pause_ms` is deterministic. Paused at
		// 14:00:00Z, resumed at 14:03:00Z → 3 minutes = 180000 ms.
		const frozenNow = new Date('2026-08-30T14:03:00Z').getTime()
		const { result } = renderHook(
			() => useSlackAutoResume(workspaceId, { now: () => frozenNow }),
			{ wrapper: TestWrapper },
		)

		await result.current.resume(trigger)

		await waitFor(() => {
			expect(vi.mocked(trackSlackTriggerResumedFromAutoPause)).toHaveBeenCalledTimes(1)
		})
		expect(vi.mocked(trackSlackTriggerResumedFromAutoPause)).toHaveBeenCalledWith({
			workspace_id: workspaceId,
			trigger_id: trigger.id,
			channel_id: autoPausedMetadata.channel_id,
			time_since_pause_ms: 180000,
		})

		expect(vi.mocked(api.triggers.update)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(api.triggers.update)).toHaveBeenCalledWith(trigger.id, workspaceId, {
			enabled: true,
			clear_auto_paused: true,
		})
	})

	it('is a no-op when the trigger has no auto_paused metadata (defensive guard)', async () => {
		vi.mocked(api.triggers.update).mockResolvedValue(buildTrigger())

		const trigger = buildTrigger({ metadata: null })
		const { result } = renderHook(() => useSlackAutoResume(workspaceId), {
			wrapper: TestWrapper,
		})

		await result.current.resume(trigger)

		expect(vi.mocked(trackSlackTriggerResumedFromAutoPause)).not.toHaveBeenCalled()
		expect(vi.mocked(api.triggers.update)).not.toHaveBeenCalled()
	})

	it('clamps time_since_pause_ms to 0 when paused_at is malformed', async () => {
		vi.mocked(api.triggers.update).mockResolvedValue(buildTrigger({ enabled: true }))

		const trigger = buildTrigger({
			metadata: {
				auto_paused: { ...autoPausedMetadata, paused_at: 'not-a-date' },
			},
		})

		const { result } = renderHook(
			() => useSlackAutoResume(workspaceId, { now: () => 999 }),
			{ wrapper: TestWrapper },
		)
		await result.current.resume(trigger)

		await waitFor(() => {
			expect(vi.mocked(trackSlackTriggerResumedFromAutoPause)).toHaveBeenCalledTimes(1)
		})
		const call = vi.mocked(trackSlackTriggerResumedFromAutoPause).mock.calls[0]?.[0]
		expect(call?.time_since_pause_ms).toBe(0)
	})
})
