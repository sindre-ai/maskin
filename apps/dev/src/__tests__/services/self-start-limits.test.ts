import { describe, expect, it } from 'vitest'
import {
	BACKOFF_BASE_MS,
	BACKOFF_CEILING_MS,
	type StreakSession,
	agentBudgetLimit,
	backoffDecision,
	backoffWaitMs,
	budgetState,
	capNoteText,
	classifyStartReason,
	continuationCapReached,
	continuationStreak,
	isContinuation,
	isSelfStarted,
	markExtendSessions,
	noChangeRuns,
	noChangeStreak,
} from '../../services/self-start-limits'

const HOUR = 60 * 60_000
const T0 = new Date('2026-11-11T08:00:00Z')

const at = (hours: number) => new Date(T0.getTime() + hours * HOUR)

function session(over: Partial<StreakSession> & { n: number }): StreakSession {
	const { n, ...rest } = over
	return {
		id: `s-${n}`,
		reason: 'self_wakeup',
		live: false,
		createdAt: at(n),
		startedAt: at(n),
		completedAt: at(n + 0.5),
		plannedCheck: false,
		...rest,
	}
}

describe('classifyStartReason', () => {
	const base = { callerKind: 'rest', hasChat: false, creatorType: 'human' } as const

	it('takes a reason the caller passed itself', () => {
		expect(classifyStartReason({ ...base, config: { start_reason: 'sweep' } })).toBe('sweep')
	})

	it('ignores a reason that is not a known value', () => {
		expect(classifyStartReason({ ...base, config: { start_reason: 'whenever' } })).toBe('person')
	})

	it('labels a task restart from its config', () => {
		expect(classifyStartReason({ ...base, config: { task_restart: { attempt: 1 } } })).toBe(
			'task_restart',
		)
	})

	it('labels a retry', () => {
		expect(classifyStartReason({ ...base, retryOf: 'prev' })).toBe('retry')
	})

	it('labels a chat turn as a person, whoever the creator is', () => {
		expect(classifyStartReason({ ...base, callerKind: 'chat', creatorType: 'agent' })).toBe(
			'person',
		)
		expect(classifyStartReason({ ...base, hasChat: true, creatorType: 'agent' })).toBe('person')
	})

	it.each([
		['cron', 'trigger_cron'],
		['reminder', 'self_wakeup'],
		['event', 'trigger_event'],
	] as const)('labels a %s trigger as %s, even when a person made the trigger', (type, reason) => {
		expect(
			classifyStartReason({
				...base,
				callerKind: 'trigger',
				triggerType: type,
				creatorType: 'human',
			}),
		).toBe(reason)
	})

	it('labels a request by a person as person and by an agent as agent_request', () => {
		expect(classifyStartReason({ ...base, callerKind: 'trigger', creatorType: 'human' })).toBe(
			'person',
		)
		expect(classifyStartReason({ ...base, callerKind: 'trigger', creatorType: 'agent' })).toBe(
			'agent_request',
		)
	})

	it('labels platform-made sessions internal', () => {
		expect(classifyStartReason({ ...base, callerKind: 'internal', creatorType: 'unknown' })).toBe(
			'internal',
		)
		expect(classifyStartReason({ ...base, creatorType: 'unknown' })).toBe('internal')
	})
})

describe('reason groups', () => {
	it('counts only runs nobody asked for in the moment as self-started', () => {
		expect(isSelfStarted('person')).toBe(false)
		expect(isSelfStarted('internal')).toBe(false)
		expect(isSelfStarted('retry')).toBe(false)
		expect(isSelfStarted('trigger_cron')).toBe(true)
		expect(isSelfStarted('self_wakeup')).toBe(true)
	})

	it('caps continuations, not fresh starts', () => {
		expect(isContinuation('task_restart')).toBe(true)
		expect(isContinuation('sweep')).toBe(true)
		expect(isContinuation('trigger_event')).toBe(false)
		expect(isContinuation('person')).toBe(false)
	})
})

describe('continuation cap', () => {
	it('allows 2 in a row and stops the 3rd', () => {
		const one = [session({ n: 1 })]
		const two = [session({ n: 2 }), session({ n: 1 })]
		expect(continuationCapReached(continuationStreak(one, 'self_wakeup'))).toBe(false)
		expect(continuationCapReached(continuationStreak(two, 'self_wakeup'))).toBe(true)
	})

	it('is broken by a run with another reason, a person included', () => {
		const recent = [
			session({ n: 3 }),
			session({ n: 2, reason: 'person' }),
			session({ n: 1 }),
			session({ n: 0 }),
		]
		expect(continuationStreak(recent, 'self_wakeup')).toBe(1)
	})

	it('does not count a session from before the label existed', () => {
		const recent = [session({ n: 2 }), session({ n: 1, reason: null })]
		expect(continuationStreak(recent, 'self_wakeup')).toBe(1)
	})
})

describe('noChangeRuns', () => {
	it('counts self-started runs in a row with nothing on the object while they ran', () => {
		const recent = [session({ n: 2 }), session({ n: 1 })]
		expect(noChangeRuns(recent, [])).toBe(2)
	})

	it('stops at the first run that changed something', () => {
		const recent = [session({ n: 3 }), session({ n: 2 }), session({ n: 1 })]
		expect(noChangeRuns(recent, [at(2.2)])).toBe(1)
	})

	it('ignores changes made between runs', () => {
		const recent = [session({ n: 2 }), session({ n: 1 })]
		expect(noChangeRuns(recent, [at(1.8)])).toBe(2)
	})

	it('does not count a check the plan asked for as nothing changed', () => {
		const recent = [session({ n: 2, plannedCheck: true }), session({ n: 1 })]
		expect(noChangeRuns(recent, [])).toBe(0)
	})

	it('cannot judge while the newest run is still live', () => {
		const recent = [session({ n: 2, live: true, completedAt: null }), session({ n: 1 })]
		expect(noChangeRuns(recent, [])).toBe(0)
	})

	it('stops at a person-started run', () => {
		const recent = [session({ n: 2 }), session({ n: 1, reason: 'person' })]
		expect(noChangeRuns(recent, [])).toBe(1)
	})
})

describe('an extend reply', () => {
	// Three quiet runs (1, 2, 3), a person asked at hour 4, the person's reply started run 5.
	const threeQuiet = () => [
		session({ n: 5, reason: 'person' }),
		session({ n: 3 }),
		session({ n: 2 }),
		session({ n: 1 }),
	]

	it('marks the first person-started run after an ask, and only that one', () => {
		const recent = [session({ n: 7, reason: 'person' }), ...threeQuiet()]
		const marked = markExtendSessions(recent, [at(4)])
		expect(marked.filter((s) => s.extend).map((s) => s.id)).toEqual(['s-5'])
	})

	it('marks nothing when nobody was asked', () => {
		expect(markExtendSessions(threeQuiet(), []).some((s) => s.extend)).toBe(false)
	})

	it('keeps the quiet count running across the extend', () => {
		const marked = markExtendSessions(threeQuiet(), [at(4)])
		expect(noChangeStreak(marked, [])).toEqual({ runs: 3, extended: true })
	})

	it('without the mark, the person run ends the streak', () => {
		expect(noChangeStreak(threeQuiet(), [])).toEqual({ runs: 0, extended: false })
	})

	it('does not count what happened while the extend run ran as a change', () => {
		const marked = markExtendSessions(threeQuiet(), [at(4)])
		expect(noChangeStreak(marked, [at(5.2)])).toEqual({ runs: 3, extended: true })
	})

	it('resets the count on a status change or edit after the extend', () => {
		const marked = markExtendSessions(threeQuiet(), [at(4)])
		expect(noChangeStreak(marked, [at(6)])).toEqual({ runs: 0, extended: false })
	})

	it('resets the count when the run after the extend changed something', () => {
		const marked = markExtendSessions([session({ n: 8 }), ...threeQuiet()], [at(4)])
		expect(noChangeStreak(marked, [at(8.2)])).toEqual({ runs: 0, extended: false })
	})

	it('doubles the wait for the next run: 1x before the ask, 2x after the extend', () => {
		const lastEndedAt = at(3.5)
		expect(backoffDecision({ runsWithNoChange: 2, lastEndedAt, now: at(3.6) })).toMatchObject({
			kind: 'wait',
			waitMs: BACKOFF_BASE_MS,
		})
		expect(backoffDecision({ runsWithNoChange: 3, lastEndedAt, now: at(4.6) })).toEqual({
			kind: 'ask',
		})
		expect(
			backoffDecision({ runsWithNoChange: 3, lastEndedAt, now: at(4.6), extended: true }),
		).toMatchObject({ kind: 'wait', waitMs: 2 * BACKOFF_BASE_MS })
		expect(
			backoffDecision({ runsWithNoChange: 3, lastEndedAt, now: at(4.6), extended: true }),
		).not.toHaveProperty('atCeiling')
	})

	it('flags the ceiling so a person is asked again, only there', () => {
		expect(
			backoffDecision({ runsWithNoChange: 9, lastEndedAt: at(0), now: at(1), extended: true }),
		).toMatchObject({ kind: 'wait', waitMs: BACKOFF_CEILING_MS, atCeiling: true })
	})
})

describe('back-off', () => {
	it('has no wait before the 2nd quiet run, then doubles up to the ceiling', () => {
		expect(backoffWaitMs(0)).toBe(0)
		expect(backoffWaitMs(1)).toBe(0)
		expect(backoffWaitMs(2)).toBe(BACKOFF_BASE_MS)
		expect(backoffWaitMs(3)).toBe(2 * BACKOFF_BASE_MS)
		expect(backoffWaitMs(4)).toBe(4 * BACKOFF_BASE_MS)
		expect(backoffWaitMs(20)).toBe(BACKOFF_CEILING_MS)
	})

	it('holds the next run until the wait after the last run has passed', () => {
		const lastEndedAt = at(0)
		const early = backoffDecision({ runsWithNoChange: 2, lastEndedAt, now: at(0.5) })
		expect(early).toEqual({
			kind: 'wait',
			retryAt: new Date(lastEndedAt.getTime() + BACKOFF_BASE_MS),
			waitMs: BACKOFF_BASE_MS,
		})
		expect(backoffDecision({ runsWithNoChange: 2, lastEndedAt, now: at(1.5) })).toEqual({
			kind: 'admit',
		})
	})

	it('asks a person after 3 quiet runs, whatever the time', () => {
		expect(backoffDecision({ runsWithNoChange: 3, lastEndedAt: at(0), now: at(100) })).toEqual({
			kind: 'ask',
		})
	})

	it('lets the first quiet run be followed straight away', () => {
		expect(backoffDecision({ runsWithNoChange: 1, lastEndedAt: at(0), now: at(0) })).toEqual({
			kind: 'admit',
		})
	})
})

describe('daily budget per agent', () => {
	it('is ok, warns at 80% and stops at the limit', () => {
		expect(budgetState(0, 1000)).toBe('ok')
		expect(budgetState(799, 1000)).toBe('ok')
		expect(budgetState(800, 1000)).toBe('warn')
		expect(budgetState(999, 1000)).toBe('warn')
		expect(budgetState(1000, 1000)).toBe('blocked')
	})

	it('reads the agent amount, then the default, and none when nothing is set', () => {
		const agent = '11111111-1111-4111-8111-111111111111'
		const other = '22222222-2222-4222-8222-222222222222'
		const settings = { agent_daily_budget: { default_tokens: 500, per_agent: { [agent]: 900 } } }
		expect(agentBudgetLimit(settings, agent)).toBe(900)
		expect(agentBudgetLimit(settings, other)).toBe(500)
		expect(agentBudgetLimit({}, agent)).toBeNull()
		expect(agentBudgetLimit(null, agent)).toBeNull()
		expect(agentBudgetLimit({ agent_daily_budget: { default_tokens: -5 } }, agent)).toBeNull()
	})
})

describe('capNoteText', () => {
	it('names the limit and the next step for a person, in plain words', () => {
		const text = capNoteText('task_restart')
		expect(text).toContain('2 restart runs in a row')
		expect(text).toContain('Next step for a person')
		expect(text).not.toMatch(/[`—–]/)
	})
})
