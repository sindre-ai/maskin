import type { Database, Transaction } from '@maskin/db'
import { actors, objects, relationships, workspaces } from '@maskin/db/schema'
import { TARGET_OF_RELATIONSHIP_TYPE, TARGET_TYPE } from '@maskin/ext-targets/shared'
import { type LoopTarget, loopTargetSchema } from '@maskin/shared'
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'

/** The one company target the move leaves behind. */
export const COMPANY_TARGET_TITLE = '10 paying customers'

/**
 * Deadline on the company target: 31 Jan 2027, set by Sebastian on 5 Nov 2026 and in the
 * November plan page (Commercial plan v19). It is the default; pass another date to override it.
 */
export const COMPANY_TARGET_DEADLINE = '2027-01-31'

/**
 * Flow rows that count as "10 paying customers". The real rows read "Paying customers by
 * 31 Jan 2027 (...)" with no 10 in the label, so match paying + customers/orgs and a target of 10.
 */
export function isCompanyTargetRow(row: Pick<LoopTarget, 'label' | 'target'>): boolean {
	return (
		row.target === 10 && /\bpaying\b.*\b(customers?|orgs?|organi[sz]ations?)\b/i.test(row.label)
	)
}

/** Keeps two concurrent runs from each creating the same objects. */
const MOVE_LOCK_KEY = 'maskin:move-targets-to-objects'

export interface PlannedFlowTarget {
	workspaceId: string
	loopId: string
	loopTitle: string
	label: string
	servesCompanyTarget: boolean
	/** The row's actual number, owner and so on, as the object will hold them. */
	row: LoopTarget
}

export interface MoveTargetsResult {
	dryRun: boolean
	flowTargetsToCreate: PlannedFlowTarget[]
	/** Rows that already have a target object. */
	flowTargetsExisting: number
	companyTargetsToCreate: number
	/** breaks_into links from the company target down to flow targets, still to be created. */
	companyLinksToCreate: number
	/** Rows in metadata.targets that fail the row shape check. They stay where they are. */
	invalidRows: Array<{ loopId: string; label: string }>
	/** Workspaces that have target rows but do not have the targets extension enabled. */
	skippedWorkspaceIds: string[]
}

type Writer = Database | Transaction

const keyOf = (loopId: string, title: string) => `${loopId}\u0000${title}`

/**
 * One-off move of the target rows inside flows (`metadata.targets` on a loop) into target
 * objects. Each row becomes a target object linked to its flow with `target_of`, keeping
 * label (title), source, actual, target and owner (driver). The rows stay in place.
 *
 * The rows that read "10 paying customers" also get one company target (no flow, one
 * deadline) that links down to those flow targets with `breaks_into`.
 *
 * Safe to re-run: a row whose target object already exists (same flow, same title) is
 * left alone, as are the company target and its links. With `dryRun` nothing is written.
 * To undo the move, delete the target objects it created.
 */
export async function moveTargetsToObjects(
	db: Database,
	options: { dryRun?: boolean; workspaceId?: string; companyDeadline?: string } = {},
): Promise<MoveTargetsResult> {
	const dryRun = options.dryRun === true
	const deadline = options.companyDeadline ?? COMPANY_TARGET_DEADLINE

	const run = async (tx: Transaction): Promise<MoveTargetsResult> => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${MOVE_LOCK_KEY}))`)
		const result: MoveTargetsResult = {
			dryRun,
			flowTargetsToCreate: [],
			flowTargetsExisting: 0,
			companyTargetsToCreate: 0,
			companyLinksToCreate: 0,
			invalidRows: [],
			skippedWorkspaceIds: [],
		}

		const loops = await tx
			.select({
				id: objects.id,
				workspaceId: objects.workspaceId,
				title: objects.title,
				metadata: objects.metadata,
				createdBy: objects.createdBy,
			})
			.from(objects)
			.where(
				and(
					eq(objects.type, 'loop'),
					ne(objects.status, 'archived'),
					options.workspaceId ? eq(objects.workspaceId, options.workspaceId) : undefined,
				),
			)
			.orderBy(asc(objects.createdAt), asc(objects.id))

		const wsRows = await tx
			.select({ id: workspaces.id, settings: workspaces.settings })
			.from(workspaces)
			.where(
				inArray(
					workspaces.id,
					loops.map((l) => l.workspaceId),
				),
			)
		const enabled = new Set(
			wsRows
				.filter((w) => {
					const modules = (w.settings as { enabled_modules?: unknown } | null)?.enabled_modules
					return Array.isArray(modules) && modules.includes('targets')
				})
				.map((w) => w.id),
		)

		type LoopRow = (typeof loops)[number]
		const withRows: Array<{ loop: LoopRow; rows: LoopTarget[] }> = []
		const skipped = new Set<string>()
		for (const loop of loops) {
			const raw = (loop.metadata as { targets?: unknown } | null)?.targets
			if (!Array.isArray(raw) || raw.length === 0) continue
			if (!enabled.has(loop.workspaceId)) {
				skipped.add(loop.workspaceId)
				continue
			}
			const rows: LoopTarget[] = []
			for (const item of raw) {
				const parsed = loopTargetSchema.safeParse(item)
				if (parsed.success) rows.push(parsed.data)
				else {
					const label = (item as { label?: unknown } | null)?.label
					result.invalidRows.push({
						loopId: loop.id,
						label: typeof label === 'string' ? label : '(no label)',
					})
				}
			}
			if (rows.length > 0) withRows.push({ loop, rows })
		}
		result.skippedWorkspaceIds = [...skipped]
		if (withRows.length === 0) return result

		// Target objects already linked to these flows, and the company targets already there.
		const loopIds = withRows.map((w) => w.loop.id)
		const linked = await tx
			.select({
				loopId: relationships.targetId,
				id: objects.id,
				title: objects.title,
			})
			.from(relationships)
			.innerJoin(objects, eq(objects.id, relationships.sourceId))
			.where(
				and(
					eq(relationships.type, TARGET_OF_RELATIONSHIP_TYPE),
					inArray(relationships.targetId, loopIds),
					eq(objects.type, TARGET_TYPE),
				),
			)
		const existingByKey = new Map(linked.map((l) => [keyOf(l.loopId, l.title ?? ''), l.id]))

		const workspaceIds = [...new Set(withRows.map((w) => w.loop.workspaceId))]
		const candidates = await tx
			.select({ id: objects.id, workspaceId: objects.workspaceId })
			.from(objects)
			.where(
				and(
					eq(objects.type, TARGET_TYPE),
					eq(objects.title, COMPANY_TARGET_TITLE),
					inArray(objects.workspaceId, workspaceIds),
				),
			)
		const flowTargetIds = new Set(linked.map((l) => l.id))
		const existingCompany = new Map<string, string>()
		for (const c of candidates) {
			// A flow target can carry the same title; only one with no flow is the company target.
			if (!flowTargetIds.has(c.id)) existingCompany.set(c.workspaceId, c.id)
		}

		const ownerIds = [
			...new Set(withRows.flatMap((w) => w.rows.map((r) => r.ownerActorId).filter(Boolean))),
		] as string[]
		const knownOwners = new Set(
			ownerIds.length === 0
				? []
				: (await tx.select({ id: actors.id }).from(actors).where(inArray(actors.id, ownerIds))).map(
						(a) => a.id,
					),
		)

		// Plan, in the order the rows sit today.
		const company = new Map<
			string,
			{ row: LoopTarget; createdBy: string; serves: Array<{ loopId: string; title: string }> }
		>()
		for (const { loop, rows } of withRows) {
			for (const row of rows) {
				const exists = existingByKey.has(keyOf(loop.id, row.label))
				const serves = isCompanyTargetRow(row)
				if (exists) result.flowTargetsExisting++
				else {
					result.flowTargetsToCreate.push({
						workspaceId: loop.workspaceId,
						loopId: loop.id,
						loopTitle: loop.title ?? '',
						label: row.label,
						servesCompanyTarget: serves,
						row,
					})
				}
				if (serves) {
					const entry = company.get(loop.workspaceId) ?? {
						row,
						createdBy: loop.createdBy,
						serves: [],
					}
					entry.serves.push({ loopId: loop.id, title: row.label })
					company.set(loop.workspaceId, entry)
				}
			}
		}

		// Existing links from a company target, so a re-run counts nothing new.
		const existingCompanyIds = [...existingCompany.values()]
		const existingLinks =
			existingCompanyIds.length === 0
				? []
				: await tx
						.select({ sourceId: relationships.sourceId, targetId: relationships.targetId })
						.from(relationships)
						.where(
							and(
								eq(relationships.type, 'breaks_into'),
								inArray(relationships.sourceId, existingCompanyIds),
							),
						)
		const linkKeys = new Set(existingLinks.map((l) => `${l.sourceId}\u0000${l.targetId}`))
		for (const [workspaceId, entry] of company) {
			const companyId = existingCompany.get(workspaceId)
			if (!companyId) result.companyTargetsToCreate++
			for (const s of entry.serves) {
				const targetId = existingByKey.get(keyOf(s.loopId, s.title))
				// A flow target that is about to be created has no id yet, so its link is new too.
				if (!companyId || !targetId || !linkKeys.has(`${companyId}\u0000${targetId}`)) {
					result.companyLinksToCreate++
				}
			}
		}

		if (dryRun) return result

		await writePlan(tx, {
			plan: result.flowTargetsToCreate,
			loopsById: new Map(withRows.map((w) => [w.loop.id, w.loop])),
			knownOwners,
			existingByKey,
			company,
			existingCompany,
			deadline,
		})
		return result
	}

	const result = await db.transaction(run)
	logger.info('Move targets to objects finished', {
		dryRun,
		flowTargetsToCreate: result.flowTargetsToCreate.length,
		flowTargetsExisting: result.flowTargetsExisting,
		companyTargetsToCreate: result.companyTargetsToCreate,
		companyLinksToCreate: result.companyLinksToCreate,
	})
	return result
}

async function writePlan(
	tx: Writer,
	params: {
		plan: PlannedFlowTarget[]
		loopsById: Map<string, { createdBy: string }>
		knownOwners: Set<string>
		existingByKey: Map<string, string>
		company: Map<
			string,
			{ row: LoopTarget; createdBy: string; serves: Array<{ loopId: string; title: string }> }
		>
		existingCompany: Map<string, string>
		deadline: string
	},
) {
	const { plan, loopsById, knownOwners, existingByKey, company, existingCompany, deadline } = params

	// The flows list orders targets by link time, then object time. Stamp each one a
	// millisecond apart so the order stays the order of the old rows (a plain insert
	// would give every row of the transaction the same time).
	const base = Date.now()
	let tick = 0
	const nextTime = () => new Date(base + tick++)

	for (const item of plan) {
		const loop = loopsById.get(item.loopId)
		if (!loop) continue
		const { row } = item
		const driver = row.ownerActorId && knownOwners.has(row.ownerActorId) ? row.ownerActorId : null
		const at = nextTime()
		const [created] = await tx
			.insert(objects)
			.values({
				workspaceId: item.workspaceId,
				type: TARGET_TYPE,
				title: row.label,
				status: 'open',
				metadata: { source: row.source, actual: row.actual, target: row.target },
				driver,
				createdBy: loop.createdBy,
				createdAt: at,
				updatedAt: at,
			})
			.returning()
		if (!created) throw new Error(`Failed to create the target object for "${row.label}"`)
		await tx.insert(relationships).values({
			sourceType: 'object',
			sourceId: created.id,
			targetType: 'object',
			targetId: item.loopId,
			type: TARGET_OF_RELATIONSHIP_TYPE,
			createdBy: loop.createdBy,
			createdAt: at,
		})
		await recordEvent(tx, {
			workspaceId: item.workspaceId,
			actorId: loop.createdBy,
			action: 'created',
			entityType: TARGET_TYPE,
			entityId: created.id,
			data: { ...created, source: 'move_targets_to_objects' },
		})
		existingByKey.set(keyOf(item.loopId, row.label), created.id)
	}

	for (const [workspaceId, entry] of company) {
		let companyId = existingCompany.get(workspaceId)
		if (!companyId) {
			const owner = entry.row.ownerActorId
			const [created] = await tx
				.insert(objects)
				.values({
					workspaceId,
					type: TARGET_TYPE,
					title: COMPANY_TARGET_TITLE,
					status: 'open',
					metadata: {
						deadline,
						source: entry.row.source,
						actual: entry.row.actual,
						target: entry.row.target,
					},
					driver: owner && knownOwners.has(owner) ? owner : null,
					createdBy: entry.createdBy,
				})
				.returning()
			if (!created) throw new Error('Failed to create the company target')
			companyId = created.id
			await recordEvent(tx, {
				workspaceId,
				actorId: entry.createdBy,
				action: 'created',
				entityType: TARGET_TYPE,
				entityId: created.id,
				data: { ...created, source: 'move_targets_to_objects' },
			})
		}
		for (const s of entry.serves) {
			const targetId = existingByKey.get(keyOf(s.loopId, s.title))
			if (!targetId) continue
			await tx
				.insert(relationships)
				.values({
					sourceType: 'object',
					sourceId: companyId,
					targetType: 'object',
					targetId,
					type: 'breaks_into',
					createdBy: entry.createdBy,
				})
				.onConflictDoNothing()
		}
	}
}
