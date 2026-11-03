import { events, objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import {
	SEARCH_DEMAND_EVENT_SOURCE,
	SEARCH_DEMAND_SOURCE,
	writeSearchDemand,
} from '../../lib/integrations/providers/google-search-console/search-demand'
import {
	GSC_PROVIDER,
	type GscRow,
	serializeRows,
} from '../../lib/integrations/providers/google-search-console/sync'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Sync end date is 2026-10-10, so the 30-day window is 2026-09-11 to 2026-10-10.
const NOW = new Date('2026-10-12T10:00:00Z')
const PAGE = 'https://maskin.io/docs/claude-md-vs-agents-md/'
const KEYWORD = 'claude.md vs agents.md'

const row = (date: string, query: string, impressions: number, position: number): GscRow => [
	date,
	PAGE,
	query,
	'usa',
	'DESKTOP',
	impressions,
	0,
	0,
	position,
]

describe('writeSearchDemand — metadata merge and audit against real Postgres', () => {
	let workspaceId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		await insertObject(db, workspaceId, getTestActorId(), {
			type: 'knowledge',
			metadata: { provider: GSC_PROVIDER },
			content: serializeRows([
				row('2026-10-01', KEYWORD, 30, 12),
				row('2026-10-02', KEYWORD, 10, 12),
				row('2026-10-02', 'rare query', 3, 4),
				// outside the 30-day window: must not count
				row('2026-08-01', KEYWORD, 500, 12),
			]),
		})
	})

	const livePiece = (metadata: Record<string, unknown>) =>
		insertObject(db, workspaceId, getTestActorId(), {
			type: 'content',
			status: 'live',
			metadata: { canonical_url: PAGE, ...metadata },
		})

	const metadataOf = async (id: string) => {
		const [found] = await db
			.select({ metadata: objects.metadata })
			.from(objects)
			.where(eq(objects.id, id))
		return found?.metadata as Record<string, unknown>
	}

	it('writes the derived value next to the existing metadata and audits it as automated', async () => {
		const piece = await livePiece({ primary_keyword: KEYWORD, seo_status: 'draft' })

		const result = await writeSearchDemand(db, { workspaceId, actorId: getTestActorId(), now: NOW })

		expect(result).toMatchObject({ updated: 1, preserved: 0 })
		// 40 impressions in the window at average position 12 -> multiplier 3
		expect(await metadataOf(piece.id)).toMatchObject({
			primary_keyword: KEYWORD,
			seo_status: 'draft',
			search_demand: 120,
			search_demand_source: SEARCH_DEMAND_SOURCE,
			search_demand_derived_at: '2026-10-12',
		})

		const audit = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, workspaceId), eq(events.entityId, piece.id)))
		expect(audit).toHaveLength(1)
		expect(audit[0]?.data).toMatchObject({
			source: SEARCH_DEMAND_EVENT_SOURCE,
			field: 'search_demand',
			old: null,
			new: 120,
			impressions: 40,
		})
	})

	it('leaves a hand-entered value and a piece under the impressions floor untouched', async () => {
		const typed = await livePiece({ primary_keyword: KEYWORD, search_demand: 390 })
		const rare = await livePiece({ primary_keyword: 'rare query' })

		const result = await writeSearchDemand(db, { workspaceId, actorId: getTestActorId(), now: NOW })

		expect(result).toMatchObject({ updated: 0, preserved: 1, skipped: 1 })
		expect((await metadataOf(typed.id)).search_demand).toBe(390)
		expect(await metadataOf(rare.id)).not.toHaveProperty('search_demand')
	})
})
