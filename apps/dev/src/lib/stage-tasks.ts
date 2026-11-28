/**
 * stage-tasks.ts — the standard task list of a flow stage (bet "Flows that run like development").
 *
 * The list lives on the flow, in `metadata.stage_tasks`, as plain text a person and the Chief of
 * Staff can both read and edit. It uses the string-array map shape that `closed_statuses` already
 * uses, so no schema or write-path change is needed:
 *
 *   { "event:greenlit": ["Book the room | Events Lead | +2d | The booking confirmation is linked"] }
 *
 * The key is `<object type>:<status>`. Each entry is one task, fields split by " | ":
 *   title | owner | due | done test
 * Only the title is required. The owner is an actor's name (empty: the flow's driver). The due
 * is how long after the object enters the stage, `+12h` or `+3d` (empty: no date). The done test
 * is plain text and becomes the task's "Done when" line.
 */

export const STAGE_TASKS_KEY = 'stage_tasks'
const FIELD_SEPARATOR = '|'
const MAX_TASKS_PER_STAGE = 20
const TITLE_MAX_CHARS = 80

export interface StageTaskSpec {
	title: string
	/** An actor's name as written. Empty when the line leaves it to the flow's driver. */
	owner: string
	/** Milliseconds after the object entered the stage, or null for no date. */
	dueAfterMs: number | null
	doneTest: string
}

const DUE_RE = /^\+?\s*(\d{1,3})\s*([hd])$/i

/** `+12h` or `+3d` as milliseconds. Anything else, including an empty field, is no date. */
export function parseDue(text: string): number | null {
	const match = DUE_RE.exec(text.trim())
	if (!match) return null
	const amount = Number(match[1])
	return amount * (match[2]?.toLowerCase() === 'h' ? 3_600_000 : 86_400_000)
}

/** One line of the list. Null for a line with no title. */
export function parseStageTaskLine(line: string): StageTaskSpec | null {
	const [title = '', owner = '', due = '', ...doneTest] = line
		.split(FIELD_SEPARATOR)
		.map((part) => part.trim())
	const oneLine = title.replace(/\s+/g, ' ')
	if (!oneLine) return null
	return {
		title:
			oneLine.length <= TITLE_MAX_CHARS ? oneLine : `${oneLine.slice(0, TITLE_MAX_CHARS - 1)}…`,
		owner,
		dueAfterMs: parseDue(due),
		// A done test may itself hold the separator, so the rest of the line is kept whole.
		doneTest: doneTest.join(` ${FIELD_SEPARATOR} `).trim(),
	}
}

/** The standard tasks a flow holds for an object of this type entering this status. */
export function readStageTasks(metadata: unknown, type: string, status: string): StageTaskSpec[] {
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return []
	const map = (metadata as Record<string, unknown>)[STAGE_TASKS_KEY]
	if (!map || typeof map !== 'object' || Array.isArray(map)) return []
	const lines = (map as Record<string, unknown>)[`${type}:${status}`]
	if (!Array.isArray(lines)) return []
	const specs: StageTaskSpec[] = []
	for (const line of lines) {
		if (typeof line !== 'string') continue
		const spec = parseStageTaskLine(line)
		if (spec) specs.push(spec)
	}
	return specs.slice(0, MAX_TASKS_PER_STAGE)
}

/** The body of a created task: what to do, where it comes from, and what done looks like. */
export function stageTaskContent(
	spec: StageTaskSpec,
	parent: { id: string; title: string; type: string },
	stage: string,
	dueAt: Date | null,
): string {
	const lines = [
		`${spec.title}`,
		'',
		`Standard task for the ${stage} stage of "${parent.title}" (${parent.type}, ${parent.id}).${
			dueAt ? ` Due ${dueAt.toISOString()}.` : ''
		}`,
	]
	if (spec.doneTest) lines.push('', `**Done when:** ${spec.doneTest}`)
	return lines.join('\n')
}
