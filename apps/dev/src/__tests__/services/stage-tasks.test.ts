import { describe, expect, it } from 'vitest'
import {
	parseDue,
	parseStageTaskLine,
	readStageTasks,
	stageTaskContent,
} from '../../lib/stage-tasks'
import { stageTaskStatus } from '../../services/stage-tasks'

const now = new Date('2026-11-20T10:00:00.000Z')

describe('parseDue', () => {
	it('reads hours and days after entering the stage', () => {
		expect(parseDue('+12h')).toBe(12 * 3_600_000)
		expect(parseDue('+3d')).toBe(3 * 86_400_000)
		expect(parseDue('2D')).toBe(2 * 86_400_000)
	})

	it('treats anything else as no date', () => {
		expect(parseDue('')).toBeNull()
		expect(parseDue('next week')).toBeNull()
		expect(parseDue('+3w')).toBeNull()
	})
})

describe('parseStageTaskLine', () => {
	it('splits title, owner, due and done test', () => {
		expect(
			parseStageTaskLine('Book the room | Events Lead | +2d | The booking is linked on the event'),
		).toEqual({
			title: 'Book the room',
			owner: 'Events Lead',
			dueAfterMs: 2 * 86_400_000,
			doneTest: 'The booking is linked on the event',
		})
	})

	it('needs only a title', () => {
		expect(parseStageTaskLine('Send the invite')).toEqual({
			title: 'Send the invite',
			owner: '',
			dueAfterMs: null,
			doneTest: '',
		})
	})

	it('keeps a done test that holds the separator, and drops a line with no title', () => {
		expect(parseStageTaskLine('A | | | one | two')?.doneTest).toBe('one | two')
		expect(parseStageTaskLine('  | Events Lead | +1d')).toBeNull()
	})
})

describe('readStageTasks', () => {
	const metadata = {
		stage_tasks: {
			'event:greenlit': ['Book the room | Events Lead | +2d | Linked', '', 'Send the invite'],
			'contact:qualified': ['Write the first message'],
		},
	}

	it('reads the list for the type and status, skipping blank lines', () => {
		expect(readStageTasks(metadata, 'event', 'greenlit').map((t) => t.title)).toEqual([
			'Book the room',
			'Send the invite',
		])
	})

	it('is empty for a stage with no list or a flow with no lists', () => {
		expect(readStageTasks(metadata, 'event', 'live')).toEqual([])
		expect(readStageTasks({}, 'event', 'greenlit')).toEqual([])
		expect(readStageTasks(null, 'event', 'greenlit')).toEqual([])
		expect(readStageTasks({ stage_tasks: 'text' }, 'event', 'greenlit')).toEqual([])
	})
})

describe('stageTaskContent', () => {
	it('names the parent and stage and carries the done test', () => {
		const spec = parseStageTaskLine('Book the room | | +2d | The booking is linked')
		if (!spec) throw new Error('no spec')
		const body = stageTaskContent(
			spec,
			{ id: 'e1', title: '25 Nov webinar', type: 'event' },
			'greenlit',
			new Date('2026-11-22T10:00:00.000Z'),
		)
		expect(body).toContain('greenlit stage of "25 Nov webinar"')
		expect(body).toContain('Due 2026-11-22T10:00:00.000Z')
		expect(body).toContain('**Done when:** The booking is linked')
	})
})

describe('stageTaskStatus', () => {
	it('is ready now with no date or a date within 24 hours', () => {
		expect(stageTaskStatus(null, now)).toBe('todo')
		expect(stageTaskStatus(new Date(now.getTime() + 12 * 3_600_000), now)).toBe('todo')
	})

	it('waits in backlog for the sweep when due later', () => {
		expect(stageTaskStatus(new Date(now.getTime() + 3 * 86_400_000), now)).toBe('backlog')
	})
})
