import { MISFIRE_KINDS, type MisfireKind, type ResultRow } from './types'

/** The skill-lookup task is reported on its own line, outside the no-worse pass rate. */
export const H6_TASK_ID = 'H6-skill-lookup'

export interface PassLine {
	runs: number
	passed: number
	passRate: number | null
	/** Mean call_count over passing runs only. Null when nothing passed. */
	callsPerPassingTask: number | null
}

export interface Summary {
	/** The original five tasks. This is the line the no-worse rule reads. */
	original: PassLine
	/** Held-out subset of the original five. */
	heldOut: PassLine
	h6: PassLine & { allRunsPassed: boolean }
	perTask: Record<string, PassLine>
	errorsByKind: Record<MisfireKind, number>
	cost: { totalUsd: number; runsWithCost: number; meanPerRunUsd: number | null }
}

function passLine(rows: ResultRow[]): PassLine {
	const passing = rows.filter((row) => row.passed)
	return {
		runs: rows.length,
		passed: passing.length,
		passRate: rows.length ? passing.length / rows.length : null,
		callsPerPassingTask: passing.length
			? passing.reduce((sum, row) => sum + row.call_count, 0) / passing.length
			: null,
	}
}

export function summarise(rows: ResultRow[]): Summary {
	const original = rows.filter((row) => row.task_id !== H6_TASK_ID)
	const h6Rows = rows.filter((row) => row.task_id === H6_TASK_ID)
	const h6 = passLine(h6Rows)

	const perTask: Record<string, PassLine> = {}
	for (const taskId of [...new Set(rows.map((row) => row.task_id))]) {
		perTask[taskId] = passLine(rows.filter((row) => row.task_id === taskId))
	}

	const errorsByKind = Object.fromEntries(MISFIRE_KINDS.map((kind) => [kind, 0])) as Record<
		MisfireKind,
		number
	>
	for (const row of rows) {
		for (const kind of MISFIRE_KINDS) errorsByKind[kind] += row.errors_by_kind[kind]
	}

	const costed = rows.filter((row) => row.cost_usd !== null)
	const totalUsd = costed.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0)

	return {
		original: passLine(original),
		heldOut: passLine(original.filter((row) => row.held_out)),
		// H6 counts as passed in a step only when all three runs pass.
		h6: { ...h6, allRunsPassed: h6.runs >= 3 && h6.passed === h6.runs },
		perTask,
		errorsByKind,
		cost: {
			totalUsd,
			runsWithCost: costed.length,
			meanPerRunUsd: costed.length ? totalUsd / costed.length : null,
		},
	}
}
