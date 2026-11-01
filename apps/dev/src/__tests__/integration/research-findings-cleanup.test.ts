import { researchRuns } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import {
	RESEARCH_FINDINGS_RETENTION_DAYS,
	purgeExpiredResearchFindings,
} from '../../jobs/research-findings-cleanup'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-11-01T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS)

const FINDINGS = [
	{ claim: 'c', quote: 'a quote copied from a web page', url: 'https://example.com' },
]
const SOURCES = [{ n: 1, url: 'https://example.com', title: 'Example' }]

describe('purgeExpiredResearchFindings (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	async function insertRun(overrides: Partial<typeof researchRuns.$inferInsert> = {}) {
		const rows = await db
			.insert(researchRuns)
			.values({
				workspaceId,
				actorId,
				question: 'What does the Danish bookkeeping act require?',
				effort: 'simple',
				status: 'done',
				capCents: 100,
				costCents: 42,
				tokensIn: 1000,
				tokensOut: 500,
				findings: FINDINGS,
				reportMd: '# Report',
				sources: SOURCES,
				warnings: ['a warning'],
				stages: { writer: { cost_cents: 10, seconds: 3 } },
				createdAt: daysAgo(31),
				finishedAt: daysAgo(31),
				...overrides,
			})
			.returning()
		return rows[0] as typeof researchRuns.$inferSelect
	}

	async function load(id: string) {
		const rows = await db.select().from(researchRuns).where(eq(researchRuns.id, id))
		return rows[0] as typeof researchRuns.$inferSelect
	}

	it('uses a 30 day window', () => {
		expect(RESEARCH_FINDINGS_RETENTION_DAYS).toBe(30)
	})

	it('clears the findings of a 31 day old done run and keeps everything else', async () => {
		const run = await insertRun()
		await purgeExpiredResearchFindings(db, NOW)
		const after = await load(run.id)
		expect(after.findings).toBeNull()
		expect(after.reportMd).toBe(run.reportMd)
		expect(after.sources).toEqual(SOURCES)
		expect(after.warnings).toEqual(run.warnings)
		expect(after.stages).toEqual(run.stages)
		expect(after.costCents).toBe(42)
		expect(after.tokensIn).toBe(1000)
		expect(after.tokensOut).toBe(500)
		expect(after.status).toBe('done')
	})

	it('leaves a 29 day old run alone', async () => {
		const run = await insertRun({ createdAt: daysAgo(29), finishedAt: daysAgo(29) })
		await purgeExpiredResearchFindings(db, NOW)
		expect((await load(run.id)).findings).toEqual(FINDINGS)
	})

	it('leaves an old run that is still running or queued alone', async () => {
		const running = await insertRun({ status: 'running', finishedAt: null })
		const queued = await insertRun({ status: 'queued', finishedAt: null })
		await purgeExpiredResearchFindings(db, NOW)
		expect((await load(running.id)).findings).toEqual(FINDINGS)
		expect((await load(queued.id)).findings).toEqual(FINDINGS)
	})

	it('counts from finished_at, not created_at, when both are set', async () => {
		const run = await insertRun({ createdAt: daysAgo(40), finishedAt: daysAgo(29) })
		await purgeExpiredResearchFindings(db, NOW)
		expect((await load(run.id)).findings).toEqual(FINDINGS)
	})

	it('falls back to created_at when the run never finished', async () => {
		const old = await insertRun({ status: 'failed', finishedAt: null, createdAt: daysAgo(31) })
		const recent = await insertRun({ status: 'failed', finishedAt: null, createdAt: daysAgo(29) })
		await purgeExpiredResearchFindings(db, NOW)
		expect((await load(old.id)).findings).toBeNull()
		expect((await load(recent.id)).findings).toEqual(FINDINGS)
	})

	it('changes nothing on a second pass and does not count already blank findings', async () => {
		await insertRun()
		await insertRun({ findings: null })
		await insertRun({ findings: [] })
		expect(await purgeExpiredResearchFindings(db, NOW)).toBe(1)
		expect(await purgeExpiredResearchFindings(db, NOW)).toBe(0)
	})
})
