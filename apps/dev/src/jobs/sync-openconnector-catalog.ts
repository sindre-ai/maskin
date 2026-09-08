import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { installedLoops, marketplaceLoopItems, marketplaceLoops } from '@maskin/db/schema'
import { Cron } from 'croner'
import { eq, inArray, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'
import {
	type OpenConnectorProvider,
	listProviders,
	resolveOpenConnectorConfig,
} from '../lib/openconnector/client'

/**
 * Nightly sync of the OpenConnector provider catalog into ordinary marketplace
 * rows.
 *
 * Each provider becomes a *single-type* marketplace loop holding exactly one
 * `integration` item. That is not a workaround — it is how the marketplace
 * already models a standalone element: `loop-grid.tsx` files multi-type loops
 * under "Loops" and single-type loops under their own typed section, and the
 * marketplace page only fan-out-fetches items for multi-type loops. So one
 * provider renders as one card in the Integrations section, never appears in
 * Loops, and is individually installable through the existing loop install
 * path — with no schema change and nothing synthetic to filter out.
 *
 * Provenance lives in `item_snapshot.source`, a backend-only jsonb field that
 * single-type loops never ship to the browser. Users see an integration; they
 * never see a vendor name.
 *
 * The job never throws: a catalog refresh is best-effort maintenance, and a
 * runtime that is down must leave last night's catalog standing rather than
 * emptying the marketplace.
 */
const CRON_EXPRESSION = '43 2 * * *'
const CATALOG_SOURCE = 'openconnector'
const SLUG_PREFIX = 'integration-'
const CATALOG_VERSION = '1.0.0'

/** RFC-4122 v5-style deterministic id, so re-syncing a provider is idempotent. */
const NAMESPACE = 'maskin.openconnector.provider'
function deterministicUuid(providerId: string): string {
	const h = createHash('sha1').update(`${NAMESPACE}:${providerId}`).digest()
	const b = Buffer.from(h.subarray(0, 16))
	b[6] = ((b[6] as number) & 0x0f) | 0x50
	b[8] = ((b[8] as number) & 0x3f) | 0x80
	const hex = b.toString('hex')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function slugFor(providerId: string): string {
	const base = providerId
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
	return `${SLUG_PREFIX}${base || 'unknown'}`
}

function snapshotFor(p: OpenConnectorProvider): Record<string, unknown> {
	return {
		// `provider` is what buildIntegrationInsert() keys the install on.
		provider: p.id,
		name: p.name,
		description: p.description,
		category: p.category,
		icon_url: p.iconUrl,
		action_count: p.actionCount,
		config: {},
		// Backend-only provenance marker — how reconciliation finds our rows.
		source: CATALOG_SOURCE,
	}
}

export async function syncOpenConnectorCatalog(db: Database): Promise<void> {
	const config = resolveOpenConnectorConfig()
	if (!config) {
		// Not an error: a deployment with no OpenConnector runtime is supported.
		// Operator-facing only — the user simply sees no integrations.
		logger.info(
			'OpenConnector catalog sync skipped — set OPENCONNECTOR_RUNTIME_URL and OPENCONNECTOR_RUNTIME_TOKEN to a running instance to populate marketplace integrations',
		)
		return
	}

	const providers = await listProviders(config)
	if (providers === null) {
		// Unreachable or unparseable. Leave the existing catalog in place.
		logger.warn('OpenConnector catalog sync aborted — provider list unavailable, keeping catalog')
		return
	}

	let upserted = 0
	for (const provider of providers) {
		try {
			await db.transaction(async (tx) => {
				const slug = slugFor(provider.id)
				const [loop] = await tx
					.insert(marketplaceLoops)
					.values({
						name: provider.name,
						slug,
						description: provider.description ?? '',
						version: CATALOG_VERSION,
						useCase: provider.category,
					})
					.onConflictDoUpdate({
						target: marketplaceLoops.slug,
						set: {
							name: provider.name,
							description: provider.description ?? '',
							useCase: provider.category,
							updatedAt: new Date(),
						},
					})
					.returning({ id: marketplaceLoops.id })
				if (!loop) throw new Error('marketplace_loops upsert returned no row')

				const sourceItemId = deterministicUuid(provider.id)
				const snapshot = snapshotFor(provider)
				// No unique constraint on (loop_id, source_item_id) — only an
				// index — so update-then-insert rather than onConflict.
				const updated = await tx
					.update(marketplaceLoopItems)
					.set({ itemSnapshot: snapshot })
					.where(eq(marketplaceLoopItems.loopId, loop.id))
					.returning({ id: marketplaceLoopItems.id })
				if (updated.length === 0) {
					await tx.insert(marketplaceLoopItems).values({
						loopId: loop.id,
						itemType: 'integration',
						sourceItemId,
						itemSnapshot: snapshot,
					})
				}
			})
			upserted++
		} catch (err) {
			// One bad provider must not abort the whole catalog.
			logger.warn('OpenConnector provider sync failed', {
				providerId: provider.id,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	const removed = await reconcile(
		db,
		providers.map((p) => slugFor(p.id)),
	)
	logger.info('OpenConnector catalog sync complete', {
		fetched: providers.length,
		upserted,
		removed,
	})
}

/**
 * Drop catalog loops the runtime no longer lists. Only ever touches rows this
 * job created (identified by the snapshot provenance marker), and never one
 * that a workspace has installed — `installed_loops.source_loop_id` is a
 * restricting FK, so deleting an installed loop would throw and would also
 * yank a live integration out from under its workspace.
 */
async function reconcile(db: Database, liveSlugs: string[]): Promise<number> {
	const ours = await db
		.select({ id: marketplaceLoops.id, slug: marketplaceLoops.slug })
		.from(marketplaceLoops)
		.innerJoin(marketplaceLoopItems, eq(marketplaceLoopItems.loopId, marketplaceLoops.id))
		.where(sql`${marketplaceLoopItems.itemSnapshot}->>'source' = ${CATALOG_SOURCE}`)

	const live = new Set(liveSlugs)
	const stale = ours.filter((r) => !live.has(r.slug))
	if (stale.length === 0) return 0

	const staleIds = stale.map((r) => r.id)
	const installed = await db
		.select({ id: installedLoops.sourceLoopId })
		.from(installedLoops)
		.where(inArray(installedLoops.sourceLoopId, staleIds))
	const installedIds = new Set(installed.map((r) => r.id))

	const deletable = staleIds.filter((id) => !installedIds.has(id))
	if (deletable.length === 0) return 0

	// Items cascade on loop delete.
	await db.delete(marketplaceLoops).where(inArray(marketplaceLoops.id, deletable))
	if (installedIds.size > 0) {
		logger.info('OpenConnector catalog kept delisted providers that are still installed', {
			kept: installedIds.size,
		})
	}
	return deletable.length
}

export class SyncOpenConnectorCatalogJob {
	private job: Cron | null = null
	private running = false

	constructor(
		private db: Database,
		private cronExpression: string = CRON_EXPRESSION,
	) {}

	start(): void {
		if (this.job) return
		this.job = new Cron(this.cronExpression, { timezone: 'UTC' }, async () => {
			await this.tick()
		})
	}

	stop(): void {
		if (this.job) {
			this.job.stop()
			this.job = null
		}
	}

	async tick(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			await syncOpenConnectorCatalog(this.db)
		} catch (err) {
			logger.error('OpenConnector catalog sync tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}
}
