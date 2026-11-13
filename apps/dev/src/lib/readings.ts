import type { Database } from '@maskin/db'
import { objects, readings } from '@maskin/db/schema'
import { and, desc, eq, inArray } from 'drizzle-orm'

/**
 * Readings: numbers only server code can write, each with the time it was read and where it
 * came from (registrations from Luma, payments from Stripe). See 0150_readings.sql.
 *
 * `recordReading` is the only writer. Call it from webhook handlers and scheduled jobs. Do not
 * expose it through a route or an MCP tool: that there is no such path is what makes a reading
 * a number a run can check, because an agent cannot add or edit one.
 */

type ReadingRow = typeof readings.$inferSelect

/** `<namespace>.<key>`, lowercase. Same rule as the table's check constraint. */
const MEASURE_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/

/** A write the caller got wrong. Server code only, so it is thrown, not mapped to a status. */
export class ReadingError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ReadingError'
	}
}

export interface RecordReadingInput {
	workspaceId: string
	/** The object or flow the number is about. */
	subjectId: string
	/** For example luma.registrations. */
	measure: string
	value: number
	/** When the source was read. */
	readAt: Date
	/** For example luma-api or stripe. */
	source: string
	/** The source's own id for this reading. A repeated write with the same one adds no row. */
	sourceRef: string
	/** Small extra facts, for example counts by status. */
	detail?: Record<string, unknown>
}

/**
 * Append one reading. Returns `inserted: false` when the source reference was already
 * recorded for this subject, measure and source (nothing is added or changed).
 * Throws `ReadingError` on a bad input or a subject outside the workspace.
 */
export async function recordReading(
	db: Database,
	input: RecordReadingInput,
): Promise<{ inserted: boolean }> {
	if (!MEASURE_RE.test(input.measure)) {
		throw new ReadingError(`measure must look like <namespace>.<key>: ${input.measure}`)
	}
	if (!Number.isFinite(input.value)) throw new ReadingError('value must be a finite number')
	if (Number.isNaN(input.readAt.getTime())) throw new ReadingError('readAt must be a valid date')
	if (!input.source || !input.sourceRef) throw new ReadingError('source and sourceRef are required')

	const [subject] = await db
		.select({ id: objects.id })
		.from(objects)
		.where(and(eq(objects.id, input.subjectId), eq(objects.workspaceId, input.workspaceId)))
		.limit(1)
	if (!subject) throw new ReadingError('subject is not an object in this workspace')

	const inserted = await db
		.insert(readings)
		.values({
			workspaceId: input.workspaceId,
			subjectId: input.subjectId,
			measure: input.measure,
			value: input.value,
			readAt: input.readAt,
			source: input.source,
			sourceRef: input.sourceRef,
			detail: input.detail ?? {},
		})
		.onConflictDoNothing()
		.returning({ id: readings.id })
	return { inserted: inserted.length > 0 }
}

/** `${subjectId}|${measure}`, the key of the map `latestReadings` returns. */
export function readingKey(subjectId: string, measure: string): string {
	return `${subjectId}|${measure}`
}

/**
 * The newest reading (by `readAt`) for each subject and measure, keyed by `readingKey`.
 * A subject and measure with no reading is absent from the map.
 */
export async function latestReadings(
	db: Database,
	workspaceId: string,
	subjectIds: string[],
	measures: string[],
): Promise<Map<string, ReadingRow>> {
	const out = new Map<string, ReadingRow>()
	if (subjectIds.length === 0 || measures.length === 0) return out
	const rows = await db
		.selectDistinctOn([readings.subjectId, readings.measure])
		.from(readings)
		.where(
			and(
				eq(readings.workspaceId, workspaceId),
				inArray(readings.subjectId, subjectIds),
				inArray(readings.measure, measures),
			),
		)
		.orderBy(readings.subjectId, readings.measure, desc(readings.readAt), desc(readings.createdAt))
	for (const row of rows) out.set(readingKey(row.subjectId, row.measure), row)
	return out
}

/**
 * Where the number should be by `now`, as a straight line from `start` (0) to `deadline`
 * (`goal`). Computed on read, never stored. `null` when there is no usable span (no deadline,
 * or a deadline not after the start). Before the start it is 0, after the deadline it is `goal`.
 */
export function expectedByNow(input: {
	start: Date
	deadline: Date | null
	goal: number
	now: Date
}): number | null {
	const { start, deadline, goal, now } = input
	if (!deadline) return null
	const span = deadline.getTime() - start.getTime()
	if (!(span > 0) || !Number.isFinite(goal)) return null
	const fraction = Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / span))
	return goal * fraction
}
