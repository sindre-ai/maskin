import { integrations, sessionLogs } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	purgeYoutubeData,
	purgeYoutubeSessionLogs,
} from '../../lib/integrations/providers/youtube/purge'
import { SessionManager } from '../../services/session-manager'
import { buildIntegration, insertActor, insertSession, insertWorkspace } from '../factories'
import { db } from './global-setup'

/**
 * YouTube data in session logs, against real Postgres: the purge on disconnect and the standing
 * sweep. The SQL decides what is deleted, so a mocked database proves nothing here.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const OLD = new Date(Date.now() - 45 * DAY_MS)
const RECENT = new Date(Date.now() - 1 * DAY_MS)
const YOUTUBE_LINE = '{"tool":"youtube__get_channel","result":{"items":[{"id":"UC1"}]}}'

describe('YouTube session log purge and sweep', () => {
	let workspaceId: string
	let actorId: string
	let manager: SessionManager

	async function seed(
		sessionOverrides: Record<string, unknown>,
		logs: Array<{ content: string; createdAt: Date }>,
		inWorkspace = workspaceId,
	): Promise<string> {
		const session = await insertSession(db, inWorkspace, actorId, actorId, sessionOverrides)
		if (!session) throw new Error('failed to seed session')
		for (const log of logs) {
			await db.insert(sessionLogs).values({ sessionId: session.id, stream: 'stdout', ...log })
		}
		return session.id
	}

	async function logCount(sessionId: string) {
		const rows = await db.select().from(sessionLogs).where(eq(sessionLogs.sessionId, sessionId))
		return rows.length
	}

	async function addYoutubeIntegration(forWorkspace: string, status: string) {
		const [row] = await db
			.insert(integrations)
			.values(
				buildIntegration({
					workspaceId: forWorkspace,
					provider: 'youtube',
					status,
					createdBy: actorId,
				}) as typeof integrations.$inferInsert,
			)
			.returning()
		if (!row) throw new Error('failed to seed integration')
		return row
	}

	async function sweep() {
		await (manager as unknown as { pruneSessionLogs: () => Promise<void> }).pruneSessionLogs()
	}

	beforeEach(async () => {
		const actor = await insertActor(db, { type: 'agent' })
		if (!actor) throw new Error('failed to seed actor')
		actorId = actor.id
		const workspace = await insertWorkspace(db, actorId)
		if (!workspace) throw new Error('failed to seed workspace')
		workspaceId = workspace.id
		manager = new SessionManager(db, {} as StorageProvider)
	})

	describe('purgeYoutubeSessionLogs', () => {
		it('deletes ALL logs of a completed session that has a youtube__ line', async () => {
			const session = await seed({ status: 'completed', completedAt: RECENT }, [
				{ content: 'plain line before', createdAt: RECENT },
				{ content: YOUTUBE_LINE, createdAt: RECENT },
				{ content: 'plain line after', createdAt: RECENT },
			])
			await purgeYoutubeSessionLogs(db, workspaceId)
			expect(await logCount(session)).toBe(0)
		})

		it('keeps a session without a youtube__ line', async () => {
			const session = await seed({ status: 'completed', completedAt: RECENT }, [
				{ content: 'youtube_is_a_word but not the tool marker', createdAt: RECENT },
			])
			await purgeYoutubeSessionLogs(db, workspaceId)
			expect(await logCount(session)).toBe(1)
		})

		it('leaves a running session untouched', async () => {
			const session = await seed({ status: 'running', completedAt: null }, [
				{ content: YOUTUBE_LINE, createdAt: RECENT },
			])
			await purgeYoutubeSessionLogs(db, workspaceId)
			expect(await logCount(session)).toBe(1)
		})

		it('only reaches the given workspace', async () => {
			const other = await insertWorkspace(db, actorId)
			if (!other) throw new Error('failed to seed workspace')
			const elsewhere = await seed(
				{ status: 'completed', completedAt: RECENT },
				[{ content: YOUTUBE_LINE, createdAt: RECENT }],
				other.id,
			)
			await purgeYoutubeSessionLogs(db, workspaceId)
			expect(await logCount(elsewhere)).toBe(1)
		})

		it('purgeYoutubeData runs it with the workspace id', async () => {
			const session = await seed({ status: 'completed', completedAt: RECENT }, [
				{ content: YOUTUBE_LINE, createdAt: RECENT },
			])
			await purgeYoutubeData(db, { integrationId: crypto.randomUUID(), workspaceId })
			expect(await logCount(session)).toBe(0)
		})
	})

	describe('hourly sweep', () => {
		it('removes logs older than 30 days of an interactive session with a youtube__ line', async () => {
			await addYoutubeIntegration(workspaceId, 'active')
			const chat = await seed({ interactive: true, status: 'completed', completedAt: OLD }, [
				{ content: YOUTUBE_LINE, createdAt: OLD },
				{ content: 'recent chat line', createdAt: RECENT },
			])
			await sweep()
			// The old line goes, the recent one stays while the integration is active.
			expect(await logCount(chat)).toBe(1)
		})

		it('never touches interactive logs without a youtube__ line', async () => {
			await addYoutubeIntegration(workspaceId, 'revoked')
			const chat = await seed({ interactive: true, status: 'completed', completedAt: OLD }, [
				{ content: 'old chat line', createdAt: OLD },
				{ content: 'recent chat line', createdAt: RECENT },
			])
			await sweep()
			expect(await logCount(chat)).toBe(2)
		})

		it('deletes all logs of a youtube__ session once the workspace has no active integration', async () => {
			await addYoutubeIntegration(workspaceId, 'revoked')
			const chat = await seed({ interactive: true, status: 'completed', completedAt: RECENT }, [
				{ content: YOUTUBE_LINE, createdAt: RECENT },
				{ content: 'recent chat line', createdAt: RECENT },
			])
			await sweep()
			expect(await logCount(chat)).toBe(0)
		})

		it('keeps recent logs while the integration is active', async () => {
			await addYoutubeIntegration(workspaceId, 'active')
			const chat = await seed({ interactive: true, status: 'completed', completedAt: RECENT }, [
				{ content: YOUTUBE_LINE, createdAt: RECENT },
			])
			await sweep()
			expect(await logCount(chat)).toBe(1)
		})

		it('never touches a running session', async () => {
			await addYoutubeIntegration(workspaceId, 'revoked')
			const running = await seed({ interactive: true, status: 'running', completedAt: null }, [
				{ content: YOUTUBE_LINE, createdAt: OLD },
			])
			await sweep()
			expect(await logCount(running)).toBe(1)
		})

		it('ignores workspaces that never had a youtube integration', async () => {
			const chat = await seed({ interactive: true, status: 'completed', completedAt: OLD }, [
				{ content: YOUTUBE_LINE, createdAt: OLD },
			])
			await sweep()
			// No youtube integration row here, so only the general sweep applies, and it
			// exempts interactive sessions.
			expect(await logCount(chat)).toBe(1)
		})
	})
})
