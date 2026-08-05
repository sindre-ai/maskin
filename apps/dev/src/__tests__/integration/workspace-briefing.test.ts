import type { StorageProvider } from '@maskin/storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWorkspaceBriefing } from '../../services/workspace-briefing'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { db } from './global-setup'

function createNoopStorage(): StorageProvider {
	return {
		put: vi.fn().mockResolvedValue(undefined),
		get: vi.fn().mockResolvedValue(Buffer.from('')),
		list: vi.fn().mockResolvedValue([]),
		listWithMetadata: vi.fn().mockResolvedValue([]),
		delete: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		ensureBucket: vi.fn().mockResolvedValue(undefined),
	} as StorageProvider
}

describe('renderWorkspaceBriefing — commitment ordering', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		const actor = await insertActor(db)
		actorId = actor.id
		const workspace = await insertWorkspace(db, actorId)
		workspaceId = workspace.id
	})

	it('does not let a MAX_LOOPS limit drop an older breached commitment in favor of newer at-risk commitments', async () => {
		const now = Date.now()

		// An old breached commitment — the oldest row in the table, but the most
		// urgent by health tier. With a 2-tier DB ORDER BY (attention-worthy vs
		// not, ignoring the breached/at-risk split), this row loses every tiebreak
		// against the fresher at-risk rows below and falls outside .limit(MAX_LOOPS).
		await insertObject(db, workspaceId, actorId, {
			type: 'commitment',
			status: 'breached',
			title: 'Weekly release cadence',
			updatedAt: new Date(now - 30 * 24 * 60 * 60 * 1000),
		})

		// 10 fresher at-risk commitments — exactly MAX_LOOPS — each newer than the
		// breached commitment above.
		for (let i = 0; i < 10; i++) {
			await insertObject(db, workspaceId, actorId, {
				type: 'commitment',
				status: 'at-risk',
				title: `At-risk commitment ${i}`,
				updatedAt: new Date(now - i * 1000),
			})
		}

		const storage = createNoopStorage()
		const result = await renderWorkspaceBriefing(db, storage, workspaceId)

		const commitmentSection = result.slice(result.indexOf('## Commitments'))
		expect(commitmentSection).toContain('Weekly release cadence')

		// Breached must sort ahead of every at-risk commitment, not just survive the limit.
		const breachedIdx = commitmentSection.indexOf('Weekly release cadence')
		const firstAtRiskIdx = commitmentSection.indexOf('At-risk commitment 0')
		expect(breachedIdx).toBeGreaterThanOrEqual(0)
		expect(firstAtRiskIdx).toBeGreaterThan(breachedIdx)
	})
})
