import { describe, expect, it } from 'vitest'
import {
	blockerCleared,
	buildQueueWakePrompt,
	buildWakePrompt,
	childrenWakeParent,
	isClosedStatus,
	isFailedOrDiscarded,
	isTaskReady,
} from '../../services/driver-wake'

const task = (id: string, status: string) => ({ id, type: 'task', status })

describe('closed statuses', () => {
	it('uses the closed set of each type', () => {
		expect(isClosedStatus('task', 'done')).toBe(true)
		expect(isClosedStatus('task', 'validated')).toBe(true)
		expect(isClosedStatus('task', 'in_review')).toBe(false)
		expect(isClosedStatus('bet', 'succeeded')).toBe(true)
		expect(isClosedStatus('bet', 'active')).toBe(false)
		expect(isClosedStatus('contact', 'anything')).toBe(false)
	})

	it('knows failed and discarded', () => {
		expect(isFailedOrDiscarded('discarded')).toBe(true)
		expect(isFailedOrDiscarded('failed')).toBe(true)
		expect(isFailedOrDiscarded('done')).toBe(false)
	})
})

describe('childrenWakeParent', () => {
	it('wakes when the last open child closes', () => {
		const children = [task('a', 'done'), task('b', 'in_review'), task('c', 'validated')]
		expect(childrenWakeParent(children, 'b', 'done')).toBe(true)
	})

	it('waits while another child is open', () => {
		const children = [task('a', 'in_progress'), task('b', 'in_review')]
		expect(childrenWakeParent(children, 'b', 'done')).toBe(false)
	})

	it('wakes at once for a child that was discarded, even with others open', () => {
		const children = [task('a', 'in_progress'), task('b', 'in_review')]
		expect(childrenWakeParent(children, 'b', 'discarded')).toBe(true)
	})

	it('ignores a move that does not close the child', () => {
		const children = [task('a', 'done'), task('b', 'todo')]
		expect(childrenWakeParent(children, 'b', 'in_progress')).toBe(false)
	})

	it('ignores a child that is not under the parent', () => {
		expect(childrenWakeParent([task('a', 'done')], 'zzz', 'done')).toBe(false)
	})
})

describe('blockerCleared', () => {
	it('wakes when the last blocker closes', () => {
		expect(blockerCleared([task('a', 'done'), task('b', 'validated')], 'b', 'validated')).toBe(true)
	})

	it('waits while another blocker is open', () => {
		expect(blockerCleared([task('a', 'in_progress'), task('b', 'in_review')], 'b', 'done')).toBe(
			false,
		)
	})

	it('does not wake for a blocker that is not closed yet', () => {
		expect(blockerCleared([task('b', 'in_review')], 'b', 'in_progress')).toBe(false)
	})
})

describe('buildWakePrompt', () => {
	it('names the object, the reason, what changed and the stored next step', () => {
		const prompt = buildWakePrompt({
			object: { id: 'obj-1', type: 'bet', title: 'Agents take the lead', status: 'active' },
			reasons: [
				{
					reason: 'child_tasks_closed',
					changed: [{ id: 'task-9', type: 'task', status: 'done', title: 'Wake the driver' }],
				},
			],
			nextStep: {
				action: 'Open the PR into main',
				status: 'open',
				dueAt: new Date('2026-11-12T10:00:00Z'),
			},
		})
		expect(prompt).toContain('Object ID: obj-1')
		expect(prompt).toContain('Every task under this object has closed')
		expect(prompt).toContain('Wake the driver (task, now done), ID: task-9')
		expect(prompt).toContain('Open the PR into main')
		expect(prompt).toContain('change nothing and end the run')
	})

	it('leaves out the next step when there is none', () => {
		const prompt = buildWakePrompt({
			object: { id: 'o', type: 'task', title: null, status: 'todo' },
			reasons: [{ reason: 'status_changed', changed: [] }],
			nextStep: null,
		})
		expect(prompt).not.toContain('Stored next step')
		expect(prompt).toContain('(untitled)')
	})
})

describe('isTaskReady', () => {
	it('is true only for a task at todo', () => {
		expect(isTaskReady('task', 'todo')).toBe(true)
		expect(isTaskReady('task', 'backlog')).toBe(false)
		expect(isTaskReady('task', 'in_progress')).toBe(false)
		expect(isTaskReady('bet', 'todo')).toBe(false)
	})
})

describe('buildWakePrompt for a ready task', () => {
	it('says the task is ready and names it', () => {
		const prompt = buildWakePrompt({
			object: { id: 't1', type: 'task', title: 'Send the newsletter', status: 'todo' },
			reasons: [{ reason: 'task_ready', changed: [] }],
			nextStep: null,
		})
		expect(prompt).toContain('This task is ready for you')
		expect(prompt).toContain('Send the newsletter')
		expect(prompt).toContain('t1')
	})
})

describe('buildQueueWakePrompt', () => {
	const item = (n: number, withStep: boolean) => ({
		object: { id: `id-${n}`, type: 'contact', title: `Contact ${n}`, status: 'messaged' },
		nextStep: withStep
			? { action: `Message ${n}`, status: 'open', dueAt: new Date('2026-11-16T08:00:00Z') }
			: null,
	})

	it('lists every object with its stored step', () => {
		const prompt = buildQueueWakePrompt({ items: [item(1, true), item(2, false)], total: 2 })
		expect(prompt).toContain('Due now (2):')
		expect(prompt).toContain('Contact 1 (contact, messaged), ID: id-1')
		expect(prompt).toContain('Message 1')
		expect(prompt).toContain('2026-11-16T08:00:00.000Z')
		expect(prompt).toContain('Contact 2 (contact, messaged), ID: id-2')
	})

	it('says when the list was capped', () => {
		const prompt = buildQueueWakePrompt({ items: [item(1, true)], total: 40 })
		expect(prompt).toContain('Due now (1 of 40, the rest come with the next sweep):')
	})
})
