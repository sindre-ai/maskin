import type { Database, Transaction } from '@maskin/db'
import {
	events,
	actors,
	doneWhenLines,
	jobOutcomes,
	objects,
	outcomeChecks,
	relationships,
} from '@maskin/db/schema'
import {
	OUTCOME_MAX_ROUNDS,
	OUTCOME_READING_MAX_AGE_MS,
	type OutcomeCheckResponse,
	type OutcomeEnding,
	type OutcomeMark,
	type OutcomeMarkEntry,
	type OutcomeMarker,
	type OutcomeReadingUsed,
	type OutcomeStateResponse,
	isGatedCloseStatus,
} from '@maskin/shared'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { postComment } from './comments'
import { recordEvent } from './events/record-event'
import { logger } from './logger'
import { type OutcomeChecker, callCheckerModel } from './outcome-checker'
import { MEASURE_RE, latestReadings, readingKey } from './readings'

type LineRow = typeof doneWhenLines.$inferSelect
type CheckRow = typeof outcomeChecks.$inferSelect

/** A write the caller got wrong or may not make. The route maps the code to a status. */
export class OutcomeCheckError extends Error {
	constructor(
		readonly code: 'BAD_REQUEST' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT',
		message: string,
	) {
		super(message)
		this.name = 'OutcomeCheckError'
	}
}

/**
 * Thrown by the write behind PATCH /objects/{id} when an agent asks for a gated close with no
 * passed check behind it. The route runs the check first; this is the guard that holds when some
 * other caller of that write forgets to.
 */
export class OutcomeCheckRequiredError extends OutcomeCheckError {
	constructor() {
		super(
			'CONFLICT',
			'This job has an approved done-when list, so it only closes after the outcome check passes. Ask to close it again through the normal update and the check runs.',
		)
		this.name = 'OutcomeCheckRequiredError'
	}
}

/** How long a passed round stays good for the close it was run for. */
const PASSED_ROUND_TTL_MS = 10 * 60 * 1000

export const READ_ONLY_RUN_FLAG = 'read_only_run'

export interface LineReport {
	line_id: string
	text: string
	mark: OutcomeMark
	by: OutcomeMarker
	reason?: string
}

export type OutcomeVerdict = 'passed' | 'sent_back' | 'waiting_for_person' | 'round_limit_reached'

export interface OutcomeCheckResult {
	verdict: OutcomeVerdict
	/** The stored round. Unset when round 4 was refused: nothing is stored then. */
	checkId?: string
	/** The round's number. Unset for a round that only waits for a person, and when refused. */
	round?: number
	lines: LineReport[]
	/** One short paragraph for the agent that asked, in plain words. */
	message: string
}

interface ObjectRef {
	id: string
	workspaceId: string
	type: string
	status: string | null
	title: string
	content: string | null
}

type DbOrTx = Database | Transaction

async function approvedLines(db: DbOrTx, objectId: string): Promise<LineRow[]> {
	return db
		.select()
		.from(doneWhenLines)
		.where(and(eq(doneWhenLines.objectId, objectId), eq(doneWhenLines.listStatus, 'approved')))
		.orderBy(asc(doneWhenLines.position))
}

/** Rounds that sent the work back. Round 4 does not start once this reaches the limit. */
async function sentBackCount(db: DbOrTx, objectId: string): Promise<number> {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(outcomeChecks)
		.where(
			and(
				eq(outcomeChecks.objectId, objectId),
				eq(outcomeChecks.kind, 'round'),
				sql`${outcomeChecks.ending} in ('sent_back', 'round_limit_reached')`,
			),
		)
	return row?.n ?? 0
}

const COMPARISON_RE = /^(>=|<=|==|=|>|<)\s*(-?\d+(?:\.\d+)?)$/

/** Compares a reading with a line's comparison. Null when the comparison cannot be read. */
export function compareReading(value: number, comparison: string): boolean | null {
	const match = COMPARISON_RE.exec(comparison.trim())
	if (!match) return null
	const limit = Number(match[2])
	switch (match[1]) {
		case '>=':
			return value >= limit
		case '<=':
			return value <= limit
		case '>':
			return value > limit
		case '<':
			return value < limit
		default:
			return value === limit
	}
}

interface StoredReading {
	value: number
	readAt: Date
	source: string
}

/**
 * Marks one code line from a stored reading. The line's reading names a measure
 * (<namespace>.<key>). A line with no named measure, no stored reading, a reading older than 30
 * minutes or a comparison that cannot be read is cannot_tell, never yes: only a fresh number from a
 * source the agent did not write can pass a line.
 */
export function markCodeLine(
	line: Pick<LineRow, 'reading' | 'comparison'>,
	reading: StoredReading | undefined,
	now: Date,
): { mark: OutcomeMark; reason: string } {
	if (!line.reading || !MEASURE_RE.test(line.reading.trim()) || !line.comparison) {
		return { mark: 'cannot_tell', reason: 'No stored reading is named for this line.' }
	}
	if (!reading) return { mark: 'cannot_tell', reason: 'No reading has been stored yet.' }
	if (now.getTime() - reading.readAt.getTime() > OUTCOME_READING_MAX_AGE_MS) {
		return { mark: 'cannot_tell', reason: 'The latest reading is older than 30 minutes.' }
	}
	const ok = compareReading(reading.value, line.comparison)
	if (ok === null) return { mark: 'cannot_tell', reason: 'The comparison cannot be read.' }
	return {
		mark: ok ? 'yes' : 'no',
		reason: `Reading ${reading.value} from ${reading.source}, wanted ${line.comparison}.`,
	}
}

/**
 * A run that only read things and then asks to close: it caused no object write and posted no
 * comment before this request. A note for a person to look at, never a reason to pass or fail.
 */
export async function sessionOnlyRead(db: DbOrTx, sessionId: string | undefined): Promise<boolean> {
	if (!sessionId) return false
	const [wrote] = await db
		.select({ id: relationships.id })
		.from(relationships)
		.where(
			and(
				eq(relationships.type, 'produced_by'),
				eq(relationships.sourceType, 'session'),
				eq(relationships.sourceId, sessionId),
			),
		)
		.limit(1)
	if (wrote) return false
	const [commented] = await db
		.select({ id: events.id })
		.from(events)
		.where(
			and(eq(events.action, 'commented'), sql`${events.data}->>'authorSessionId' = ${sessionId}`),
		)
		.limit(1)
	return !commented
}

/**
 * Whether this agent request is held for the check: a gated close of a job that has an approved
 * done-when list. A person's own write never comes here.
 */
export async function requiresOutcomeCheck(
	db: DbOrTx,
	current: { id: string; type: string; status: string | null },
	toStatus: string | undefined,
): Promise<boolean> {
	if (toStatus === undefined || toStatus === current.status) return false
	if (!isGatedCloseStatus(current.type, toStatus)) return false
	const [row] = await db
		.select({ id: doneWhenLines.id })
		.from(doneWhenLines)
		.where(and(eq(doneWhenLines.objectId, current.id), eq(doneWhenLines.listStatus, 'approved')))
		.limit(1)
	return !!row
}

/** True when the id is a passed round for this job and this status, run a moment ago. */
export async function passedRoundStillValid(
	db: DbOrTx,
	params: { objectId: string; toStatus: string; checkId: string | undefined; now?: Date },
): Promise<boolean> {
	if (!params.checkId) return false
	const [row] = await db
		.select()
		.from(outcomeChecks)
		.where(and(eq(outcomeChecks.id, params.checkId), eq(outcomeChecks.objectId, params.objectId)))
		.limit(1)
	if (!row || row.kind !== 'round' || row.ending !== 'checks_passed') return false
	if (row.requestedStatus !== params.toStatus) return false
	const age = (params.now ?? new Date()).getTime() - row.createdAt.getTime()
	return age <= PASSED_ROUND_TTL_MS
}

function failedLinesText(lines: LineReport[], mark: OutcomeMark): string {
	return lines
		.filter((l) => l.mark === mark)
		.map((l) => `"${l.text}"${l.reason ? ` (${l.reason})` : ''}`)
		.join('; ')
}

function buildMessage(
	verdict: OutcomeVerdict,
	round: number | undefined,
	lines: LineReport[],
): string {
	if (verdict === 'passed') return 'All lines checked out, so the job can close.'
	if (verdict === 'round_limit_reached') {
		return `Not closed. Check ${OUTCOME_MAX_ROUNDS} of ${OUTCOME_MAX_ROUNDS} failed or is still failing: ${failedLinesText(lines, 'no') || 'see the stored round'}. No more rounds start. A person has been asked to look. Do not ask to close again.`
	}
	if (verdict === 'waiting_for_person') {
		return `Not closed yet. A person has to look at these lines before the job can close: ${failedLinesText(lines, 'cannot_tell')}. A person marks a line on the job's done-when list. Ask to close again once they have.`
	}
	return `Not closed. Check ${round} of ${OUTCOME_MAX_ROUNDS} sent it back. These lines are not true yet: ${failedLinesText(lines, 'no')}. Fix them, then ask to close again.${
		lines.some((l) => l.mark === 'cannot_tell')
			? ` A person still has to look at: ${failedLinesText(lines, 'cannot_tell')}.`
			: ''
	}`
}

/**
 * Runs one check round for an agent's request to close a job. Marks every line (code from stored
 * readings, the checker model from the finished thing, a person's own tick as theirs), stores the
 * round and returns the verdict. Does not change the job's status: the caller does that, only on
 * passed. Never lets the agent's words decide a mark.
 */
export async function runOutcomeCheck(
	db: Database,
	params: {
		object: ObjectRef
		toStatus: string
		actorId: string
		sessionId?: string
		now?: Date
		checker?: OutcomeChecker
	},
): Promise<OutcomeCheckResult> {
	const { object, toStatus, actorId, sessionId } = params
	const now = params.now ?? new Date()
	const checker = params.checker ?? callCheckerModel(db)

	const lines = await approvedLines(db, object.id)
	if (lines.length === 0) {
		throw new OutcomeCheckError('BAD_REQUEST', 'This job has no approved done-when list.')
	}

	if ((await sentBackCount(db, object.id)) >= OUTCOME_MAX_ROUNDS) {
		const reports = lines.map<LineReport>((l) => ({
			line_id: l.id,
			text: l.text,
			mark: l.state === 'true' ? 'yes' : l.state === 'false' ? 'no' : 'cannot_tell',
			by: 'person',
		}))
		return {
			verdict: 'round_limit_reached',
			lines: reports,
			message: `Not closed. ${OUTCOME_MAX_ROUNDS} checks already sent this job back, so no more rounds start. A person has the lines that are still failing.`,
		}
	}

	// A line a person marked stays theirs: the check never overwrites a person's tick.
	const marks: OutcomeMarkEntry[] = []
	const readingsUsed: OutcomeReadingUsed[] = []
	const reports: LineReport[] = []
	const personMarked = (line: LineRow) =>
		line.stateSetBy !== null && (line.state === 'true' || line.state === 'false')

	const codeLines = lines.filter((l) => l.checkedBy === 'code' && !personMarked(l))
	const measures = codeLines
		.map((l) => l.reading?.trim() ?? '')
		.filter((m): m is string => MEASURE_RE.test(m))
	const stored =
		measures.length > 0
			? await latestReadings(db, object.workspaceId, [object.id], [...new Set(measures)])
			: new Map()

	const checkerLines = lines.filter((l) => l.checkedBy === 'checker' && !personMarked(l))
	const checked =
		checkerLines.length > 0
			? await checker({
					workspaceId: object.workspaceId,
					lines: checkerLines.map((l) => ({ id: l.id, text: l.text })),
					thing: { title: object.title, content: object.content ?? '' },
				})
			: { model: null, verdicts: new Map() }

	for (const line of lines) {
		let mark: OutcomeMark
		let by: OutcomeMarker
		let reason: string | undefined
		if (personMarked(line)) {
			mark = line.state === 'true' ? 'yes' : 'no'
			by = 'person'
		} else if (line.checkedBy === 'code') {
			by = 'code'
			const row = line.reading ? stored.get(readingKey(object.id, line.reading.trim())) : undefined
			const result = markCodeLine(
				line,
				row ? { value: row.value, readAt: row.readAt, source: row.source } : undefined,
				now,
			)
			mark = result.mark
			reason = result.reason
			if (row && result.mark !== 'cannot_tell') {
				readingsUsed.push({
					line_id: line.id,
					measure: line.reading?.trim() ?? '',
					value: row.value,
					read_at: row.readAt.toISOString(),
					source: row.source,
				})
			}
		} else if (line.checkedBy === 'checker') {
			by = 'checker'
			const verdict = checked.verdicts.get(line.id)
			mark = verdict?.mark ?? 'cannot_tell'
			reason = verdict?.reason
		} else {
			// A person's line with no tick yet: it waits for them.
			by = 'person'
			mark = 'cannot_tell'
			reason = 'Waiting for a person.'
		}
		marks.push({ line_id: line.id, mark, by, ...(reason ? { reason } : {}) })
		reports.push({ line_id: line.id, text: line.text, mark, by, ...(reason ? { reason } : {}) })
	}

	const flags = (await sessionOnlyRead(db, sessionId)) ? [READ_ONLY_RUN_FLAG] : []
	const anyNo = marks.some((m) => m.mark === 'no')
	const anyCannotTell = marks.some((m) => m.mark === 'cannot_tell')

	const stored_ = await db.transaction(async (tx) => {
		// One round at a time per job, so two requests cannot take the same round number.
		await tx.select({ id: objects.id }).from(objects).where(eq(objects.id, object.id)).for('update')
		const sentBack = await sentBackCount(tx, object.id)
		if (sentBack >= OUTCOME_MAX_ROUNDS) return null
		// Only a round that decided something is numbered. A round that waits for a person has no
		// number and does not use up one of the three.
		const [decided] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(outcomeChecks)
			.where(
				and(
					eq(outcomeChecks.objectId, object.id),
					eq(outcomeChecks.kind, 'round'),
					sql`${outcomeChecks.ending} is not null`,
				),
			)
		const decidedRounds = decided?.n ?? 0

		let verdict: OutcomeVerdict
		let ending: OutcomeEnding | null
		if (anyNo) {
			const limit = sentBack + 1 >= OUTCOME_MAX_ROUNDS
			verdict = limit ? 'round_limit_reached' : 'sent_back'
			ending = limit ? 'round_limit_reached' : 'sent_back'
		} else if (anyCannotTell) {
			verdict = 'waiting_for_person'
			ending = null
		} else {
			verdict = 'passed'
			ending = 'checks_passed'
		}
		const round = ending ? decidedRounds + 1 : null

		const [row] = await tx
			.insert(outcomeChecks)
			.values({
				workspaceId: object.workspaceId,
				objectId: object.id,
				kind: 'round',
				round,
				marks,
				readings: readingsUsed,
				ending,
				flags,
				requestedStatus: toStatus,
				checkerModel: checked.model,
				sessionId: sessionId ?? null,
				createdBy: actorId,
			})
			.returning({ id: outcomeChecks.id })
		if (!row) throw new Error('outcome check insert returned no row')

		// Write each line's state, except a line a person marked. A person can tick it again.
		for (const line of lines) {
			if (personMarked(line)) continue
			const entry = marks.find((m) => m.line_id === line.id)
			if (!entry) continue
			await tx
				.update(doneWhenLines)
				.set({
					state: entry.mark === 'yes' ? 'true' : entry.mark === 'no' ? 'false' : 'cannot_tell',
					stateSetAt: now,
					stateSetBy: null,
				})
				.where(eq(doneWhenLines.id, line.id))
		}

		if (ending) {
			await tx
				.insert(jobOutcomes)
				.values({ objectId: object.id, workspaceId: object.workspaceId, ending, endedAt: now })
				.onConflictDoUpdate({
					target: jobOutcomes.objectId,
					set: { ending, endedAt: now, updatedAt: now },
				})
		}

		await recordEvent(tx, {
			workspaceId: object.workspaceId,
			actorId,
			action: 'outcome_checked',
			entityType: object.type,
			entityId: object.id,
			data: {
				ending,
				verdict,
				round,
				checked_by: [...new Set(marks.map((m) => m.by))],
				flagged: flags.length > 0,
			},
		})
		return { id: row.id, round, verdict }
	})

	if (!stored_) {
		return {
			verdict: 'round_limit_reached',
			lines: reports,
			message: `Not closed. ${OUTCOME_MAX_ROUNDS} checks already sent this job back, so no more rounds start.`,
		}
	}

	const result: OutcomeCheckResult = {
		verdict: stored_.verdict,
		checkId: stored_.id,
		round: stored_.round ?? undefined,
		lines: reports,
		message: buildMessage(stored_.verdict, stored_.round, reports),
	}
	if (stored_.verdict === 'round_limit_reached' || stored_.verdict === 'waiting_for_person') {
		await askPersonToLook(db, { object, actorId, result, flags })
	}
	return result
}

/**
 * One comment to the person who approved the list: the lines that still need them. Best effort: a
 * failure to post never changes the verdict. A repeat waiting round with the same lines posts
 * nothing, so a retrying agent does not flood the person.
 */
async function askPersonToLook(
	db: Database,
	params: {
		object: ObjectRef
		actorId: string
		result: OutcomeCheckResult
		flags: string[]
	},
): Promise<void> {
	try {
		const { object, actorId, result, flags } = params
		const [first] = await db
			.select({ approvedBy: doneWhenLines.approvedBy })
			.from(doneWhenLines)
			.where(and(eq(doneWhenLines.objectId, object.id), eq(doneWhenLines.listStatus, 'approved')))
			.limit(1)
		const person = first?.approvedBy
		if (!person) return

		if (result.verdict === 'waiting_for_person') {
			const waiting = result.lines
				.filter((l) => l.mark === 'cannot_tell')
				.map((l) => l.line_id)
				.sort()
				.join(',')
			const [previous] = await db
				.select()
				.from(outcomeChecks)
				.where(
					and(
						eq(outcomeChecks.objectId, object.id),
						eq(outcomeChecks.kind, 'round'),
						sql`${outcomeChecks.id} <> ${result.checkId ?? null}`,
					),
				)
				.orderBy(desc(outcomeChecks.createdAt))
				.limit(1)
			const before = ((previous?.marks ?? []) as OutcomeMarkEntry[])
				.filter((m) => m.mark === 'cannot_tell')
				.map((m) => m.line_id)
				.sort()
				.join(',')
			if (previous && previous.ending === null && before === waiting) return
		}

		const lead =
			result.verdict === 'round_limit_reached'
				? `The outcome check sent this job back ${OUTCOME_MAX_ROUNDS} times and stopped. These lines are still failing: ${failedLinesText(result.lines, 'no') || 'none marked no, see the rounds'}.`
				: `The outcome check cannot close this job without you. Please look at: ${failedLinesText(result.lines, 'cannot_tell')}.`
		const flagLine = flags.includes(READ_ONLY_RUN_FLAG)
			? ' Flag: the run that asked to close only read things and changed nothing.'
			: ''
		await postComment(db, {
			workspaceId: object.workspaceId,
			actorId,
			entityId: object.id,
			content: `${lead}${flagLine} Mark a line true or false on the job's done-when list.`,
			mentions: [person],
			attention: 4,
		})
	} catch (err) {
		logger.warn('outcome check: could not ask a person to look', {
			objectId: params.object.id,
			error: String(err),
		})
	}
}

/**
 * The hold behind an agent's request to close. Returns held false when the request is not gated, or
 * the check passed (with the round to pass on to the write). Returns held true with the words for
 * the agent when the job stays where it is.
 */
export async function holdAgentClose(
	db: Database,
	params: {
		existing: ObjectRef
		toStatus: string | undefined
		actorId: string
		sessionId?: string
		checker?: OutcomeChecker
	},
): Promise<
	{ held: false; checkId?: string } | { held: true; message: string; result: OutcomeCheckResult }
> {
	if (!(await requiresOutcomeCheck(db, params.existing, params.toStatus))) return { held: false }
	const result = await runOutcomeCheck(db, {
		object: params.existing,
		toStatus: params.toStatus as string,
		actorId: params.actorId,
		sessionId: params.sessionId,
		checker: params.checker,
	})
	if (result.verdict === 'passed') return { held: false, checkId: result.checkId }
	return { held: true, message: result.message, result }
}

function serializeCheck(row: CheckRow): OutcomeCheckResponse {
	return {
		id: row.id,
		object_id: row.objectId,
		kind: row.kind as OutcomeCheckResponse['kind'],
		round: row.round,
		marks: (row.marks ?? []) as OutcomeMarkEntry[],
		readings: (row.readings ?? []) as OutcomeReadingUsed[],
		ending: row.ending as OutcomeEnding | null,
		flags: (row.flags ?? []) as string[],
		checker_model: row.checkerModel,
		created_at: row.createdAt.toISOString(),
	}
}

/** The job's stored rounds and how checking ended, read straight from the tables. */
export async function getOutcomeState(db: DbOrTx, objectId: string): Promise<OutcomeStateResponse> {
	const [state] = await db.select().from(jobOutcomes).where(eq(jobOutcomes.objectId, objectId))
	const rows = await db
		.select()
		.from(outcomeChecks)
		.where(eq(outcomeChecks.objectId, objectId))
		.orderBy(asc(outcomeChecks.createdAt))
	return {
		object_id: objectId,
		ending: (state?.ending as OutcomeEnding | null | undefined) ?? null,
		ended_at: state?.endedAt?.toISOString() ?? null,
		accepted_by: state?.acceptedBy ?? null,
		accepted_at: state?.acceptedAt?.toISOString() ?? null,
		rounds: rows.map(serializeCheck),
	}
}

async function lockJob(tx: Transaction, objectId: string) {
	const [object] = await tx
		.select({ id: objects.id, workspaceId: objects.workspaceId, type: objects.type })
		.from(objects)
		.where(eq(objects.id, objectId))
		.for('update')
		.limit(1)
	if (!object) throw new OutcomeCheckError('NOT_FOUND', 'Object not found')
	return object
}

async function requireHuman(tx: DbOrTx, actorId: string, what: string): Promise<void> {
	const [actor] = await tx
		.select({ type: actors.type })
		.from(actors)
		.where(eq(actors.id, actorId))
		.limit(1)
	if (actor?.type !== 'human') {
		throw new OutcomeCheckError('FORBIDDEN', `Only a person can ${what}.`)
	}
}

/**
 * A person's acceptance of the work. A separate field from the ending: the check never sets it,
 * and only a person can.
 */
export async function acceptOutcome(
	db: Database,
	params: { objectId: string; actorId: string },
): Promise<OutcomeStateResponse> {
	await db.transaction(async (tx) => {
		await requireHuman(tx, params.actorId, 'accept the work')
		const object = await lockJob(tx, params.objectId)
		const now = new Date()
		await tx
			.insert(jobOutcomes)
			.values({
				objectId: object.id,
				workspaceId: object.workspaceId,
				acceptedBy: params.actorId,
				acceptedAt: now,
			})
			.onConflictDoUpdate({
				target: jobOutcomes.objectId,
				set: { acceptedBy: params.actorId, acceptedAt: now, updatedAt: now },
			})
		await recordEvent(tx, {
			workspaceId: object.workspaceId,
			actorId: params.actorId,
			action: 'outcome_accepted',
			entityType: object.type,
			entityId: object.id,
			data: {},
		})
	})
	return getOutcomeState(db, params.objectId)
}

/** A person ending the checking: the list does not fit the work, or they stopped it. */
export async function endOutcomeByPerson(
	db: Database,
	params: { objectId: string; actorId: string; ending: 'list_does_not_fit' | 'stopped_by_person' },
): Promise<OutcomeStateResponse> {
	await db.transaction(async (tx) => {
		await requireHuman(tx, params.actorId, 'end the check')
		const object = await lockJob(tx, params.objectId)
		const now = new Date()
		await tx
			.insert(jobOutcomes)
			.values({
				objectId: object.id,
				workspaceId: object.workspaceId,
				ending: params.ending,
				endedAt: now,
			})
			.onConflictDoUpdate({
				target: jobOutcomes.objectId,
				set: { ending: params.ending, endedAt: now, updatedAt: now },
			})
		await recordEvent(tx, {
			workspaceId: object.workspaceId,
			actorId: params.actorId,
			action: 'outcome_checked',
			entityType: object.type,
			entityId: object.id,
			data: { ending: params.ending, verdict: null, round: null, checked_by: ['person'] },
		})
	})
	return getOutcomeState(db, params.objectId)
}

/**
 * The blind sample: a person's own mark of the lines of a piece of work, made without seeing the
 * checker's marks, stored in the same table as the rounds. Refused when the job has no approved list.
 */
export async function recordBlindMarks(
	db: Database,
	params: {
		objectId: string
		actorId: string
		marks: Array<{ line_id: string; mark: 'yes' | 'no' }>
	},
): Promise<OutcomeStateResponse> {
	await db.transaction(async (tx) => {
		await requireHuman(tx, params.actorId, 'mark lines in the blind sample')
		const object = await lockJob(tx, params.objectId)
		const lines = await approvedLines(tx, object.id)
		const ids = new Set(lines.map((l) => l.id))
		if (lines.length === 0) {
			throw new OutcomeCheckError('BAD_REQUEST', 'This job has no approved done-when list.')
		}
		for (const m of params.marks) {
			if (!ids.has(m.line_id)) {
				throw new OutcomeCheckError('BAD_REQUEST', 'A mark names a line that is not on the list.')
			}
		}
		await tx.insert(outcomeChecks).values({
			workspaceId: object.workspaceId,
			objectId: object.id,
			kind: 'blind',
			marks: params.marks.map((m) => ({
				line_id: m.line_id,
				mark: m.mark,
				by: 'person',
				person_id: params.actorId,
			})),
			createdBy: params.actorId,
		})
	})
	return getOutcomeState(db, params.objectId)
}

/**
 * Agreement of the checker with a person on the blind sample, over lines both marked yes or no. A
 * piece counts once, against its latest round that has any checker mark. Counts only.
 */
export async function blindSampleAgreement(
	db: DbOrTx,
	workspaceId: string,
): Promise<{ pieces: number; lines: number; agreed: number }> {
	const blind = await db
		.select()
		.from(outcomeChecks)
		.where(and(eq(outcomeChecks.workspaceId, workspaceId), eq(outcomeChecks.kind, 'blind')))
	let pieces = 0
	let lines = 0
	let agreed = 0
	for (const b of blind) {
		const [round] = await db
			.select()
			.from(outcomeChecks)
			.where(
				and(
					eq(outcomeChecks.objectId, b.objectId),
					eq(outcomeChecks.kind, 'round'),
					sql`${outcomeChecks.marks} @> '[{"by":"checker"}]'::jsonb`,
				),
			)
			.orderBy(desc(outcomeChecks.createdAt))
			.limit(1)
		if (!round) continue
		const checkerMarks = new Map(
			((round.marks ?? []) as OutcomeMarkEntry[])
				.filter((m) => m.by === 'checker' && m.mark !== 'cannot_tell')
				.map((m) => [m.line_id, m.mark]),
		)
		let counted = false
		for (const m of (b.marks ?? []) as OutcomeMarkEntry[]) {
			const theirs = checkerMarks.get(m.line_id)
			if (!theirs) continue
			counted = true
			lines += 1
			if (theirs === m.mark) agreed += 1
		}
		if (counted) pieces += 1
	}
	return { pieces, lines, agreed }
}
