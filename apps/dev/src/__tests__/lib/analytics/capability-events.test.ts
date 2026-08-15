import type { AgentCapability } from '@maskin/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	dimensionsRaised,
	isLevelAdvancement,
	trackAgentCapabilityLevelAdvanced,
} from '../../../lib/analytics/capability-events'

beforeEach(() => {
	capturePosthogEventMock.mockClear()
})

function buildCapability(overrides: Partial<AgentCapability> = {}): AgentCapability {
	return {
		version: 1,
		overall: { score: 0, level: 'novice' },
		dimensions: [
			{ key: 'expertise', label: 'Expertise', score: 0, weight: 35, reasons: [] },
			{ key: 'skills', label: 'Skills', score: 0, weight: 20, reasons: [] },
			{ key: 'connectors', label: 'Connectors', score: 0, weight: 20, reasons: [] },
			{ key: 'context', label: 'Context', score: 0, weight: 10, reasons: [] },
			{ key: 'autonomy', label: 'Autonomy', score: 0, weight: 15, reasons: [] },
		],
		unresolvedPlaceholders: [],
		topGaps: [],
		...overrides,
	}
}

describe('isLevelAdvancement', () => {
	it('returns true when the new level ranks strictly higher', () => {
		expect(isLevelAdvancement('novice', 'apprentice')).toBe(true)
		expect(isLevelAdvancement('apprentice', 'practitioner')).toBe(true)
		expect(isLevelAdvancement('practitioner', 'expert')).toBe(true)
		expect(isLevelAdvancement('expert', 'master')).toBe(true)
		expect(isLevelAdvancement('novice', 'master')).toBe(true)
	})

	it('returns false when the level is unchanged', () => {
		expect(isLevelAdvancement('novice', 'novice')).toBe(false)
		expect(isLevelAdvancement('expert', 'expert')).toBe(false)
	})

	it('returns false when the level regresses', () => {
		expect(isLevelAdvancement('apprentice', 'novice')).toBe(false)
		expect(isLevelAdvancement('master', 'apprentice')).toBe(false)
	})
})

describe('dimensionsRaised', () => {
	it('returns the keys of dimensions whose per-dim score rose', () => {
		const before = buildCapability()
		const after = buildCapability({
			dimensions: [
				{ key: 'expertise', label: 'Expertise', score: 3, weight: 35, reasons: [] },
				{ key: 'skills', label: 'Skills', score: 0, weight: 20, reasons: [] },
				{ key: 'connectors', label: 'Connectors', score: 4, weight: 20, reasons: [] },
				{ key: 'context', label: 'Context', score: 0, weight: 10, reasons: [] },
				{ key: 'autonomy', label: 'Autonomy', score: 0, weight: 15, reasons: [] },
			],
		})
		expect(dimensionsRaised(before, after)).toEqual(['expertise', 'connectors'])
	})

	it('ignores dimensions that stayed flat or dropped', () => {
		const before = buildCapability({
			dimensions: [
				{ key: 'expertise', label: 'Expertise', score: 3, weight: 35, reasons: [] },
				{ key: 'skills', label: 'Skills', score: 2, weight: 20, reasons: [] },
				{ key: 'connectors', label: 'Connectors', score: 0, weight: 20, reasons: [] },
				{ key: 'context', label: 'Context', score: 0, weight: 10, reasons: [] },
				{ key: 'autonomy', label: 'Autonomy', score: 0, weight: 15, reasons: [] },
			],
		})
		const after = buildCapability({
			dimensions: [
				{ key: 'expertise', label: 'Expertise', score: 3, weight: 35, reasons: [] },
				{ key: 'skills', label: 'Skills', score: 1, weight: 20, reasons: [] },
				{ key: 'connectors', label: 'Connectors', score: 0, weight: 20, reasons: [] },
				{ key: 'context', label: 'Context', score: 0, weight: 10, reasons: [] },
				{ key: 'autonomy', label: 'Autonomy', score: 0, weight: 15, reasons: [] },
			],
		})
		expect(dimensionsRaised(before, after)).toEqual([])
	})
})

describe('trackAgentCapabilityLevelAdvanced', () => {
	it('emits with actor as distinct id and the contracted payload', async () => {
		await trackAgentCapabilityLevelAdvanced({
			actorId: 'actor-1',
			workspaceId: 'ws-1',
			fromLevel: 'novice',
			toLevel: 'apprentice',
			dimensionsChanged: ['expertise'],
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'agent_capability_level_advanced',
			'actor-1',
			{
				actor_id: 'actor-1',
				workspace_id: 'ws-1',
				from_level: 'novice',
				to_level: 'apprentice',
				dimensions_changed: ['expertise'],
			},
		)
	})

	it('carries a null workspace_id when the caller has no workspace context', async () => {
		await trackAgentCapabilityLevelAdvanced({
			actorId: 'actor-2',
			workspaceId: null,
			fromLevel: 'apprentice',
			toLevel: 'practitioner',
			dimensionsChanged: ['skills', 'connectors'],
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'agent_capability_level_advanced',
			'actor-2',
			expect.objectContaining({
				workspace_id: null,
				dimensions_changed: ['skills', 'connectors'],
			}),
		)
	})
})
