import type { ImportMapping } from '@maskin/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import { trackBulkImportExecuted } from '../../../lib/analytics/import-events'

function makeMapping(overrides: Partial<ImportMapping['typeMappings'][number]>[]): ImportMapping {
	return {
		typeMappings: overrides.map((tm) => ({
			objectType: 'bet',
			columns: [],
			...tm,
		})),
		relationships: [],
	}
}

beforeEach(() => {
	capturePosthogEventMock.mockClear()
})

describe('trackBulkImportExecuted', () => {
	it('emits bulk_import_executed with the contracted properties for the dedup-key path', async () => {
		await trackBulkImportExecuted({
			mapping: makeMapping([{ dedupKeys: ['title', 'metadata.email'] }]),
			matchedCount: 12,
			createdCount: 5,
			skippedCount: 3,
			totalRows: 20,
			workspaceId: 'ws-1',
			actorId: 'actor-1',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith('bulk_import_executed', 'ws-1', {
			dedup_keys_count: 2,
			matched_count: 12,
			created_count: 5,
			skipped_count: 3,
			used_create_all_as_new: false,
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			target_type: 'bet',
			total_rows: 20,
		})
	})

	it('reports used_create_all_as_new with dedup_keys_count=0 on the escape-hatch path', async () => {
		await trackBulkImportExecuted({
			mapping: makeMapping([{ createAllAsNew: true }]),
			matchedCount: 0,
			createdCount: 50,
			skippedCount: 0,
			totalRows: 50,
			workspaceId: 'ws-1',
			actorId: 'actor-1',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'bulk_import_executed',
			'ws-1',
			expect.objectContaining({
				dedup_keys_count: 0,
				used_create_all_as_new: true,
				matched_count: 0,
				created_count: 50,
				skipped_count: 0,
			}),
		)
	})

	it('sums dedup keys across multi-type mappings and joins target_type', async () => {
		await trackBulkImportExecuted({
			mapping: makeMapping([
				{ objectType: 'bet', dedupKeys: ['title'] },
				{ objectType: 'task', dedupKeys: ['title', 'metadata.external_id'] },
			]),
			matchedCount: 0,
			createdCount: 4,
			skippedCount: 0,
			totalRows: 4,
			workspaceId: 'ws-1',
			actorId: 'actor-1',
		})

		const props = capturePosthogEventMock.mock.calls[0]?.[2] as Record<string, unknown>
		expect(props.dedup_keys_count).toBe(3)
		expect(props.target_type).toBe('bet+task')
		expect(props.used_create_all_as_new).toBe(false)
	})

	it('does not classify a mixed (one dedup, one escape) import as escape-hatch', async () => {
		await trackBulkImportExecuted({
			mapping: makeMapping([
				{ objectType: 'bet', dedupKeys: ['title'] },
				{ objectType: 'task', createAllAsNew: true },
			]),
			matchedCount: 1,
			createdCount: 1,
			skippedCount: 0,
			totalRows: 2,
			workspaceId: 'ws-1',
			actorId: 'actor-1',
		})

		const props = capturePosthogEventMock.mock.calls[0]?.[2] as Record<string, unknown>
		expect(props.dedup_keys_count).toBe(1)
		expect(props.used_create_all_as_new).toBe(false)
	})
})
