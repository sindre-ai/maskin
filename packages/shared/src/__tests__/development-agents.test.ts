import { MENTION_DISCIPLINE } from '../prompts'
import { DEVELOPMENT_AGENTS, DEVELOPMENT_TRIGGERS } from '../templates/development-agents'

describe('mention discipline in DEVELOPMENT_AGENTS / DEVELOPMENT_TRIGGERS', () => {
	it('every agent system prompt that carries mention discipline includes the shared constant verbatim', () => {
		for (const agent of DEVELOPMENT_AGENTS) {
			if (agent.systemPrompt.includes('Mention discipline:')) {
				expect(agent.systemPrompt).toContain(MENTION_DISCIPLINE)
			}
		}
	})

	// The 8 trigger actionPrompts below each carry their own hand-written
	// "Mention discipline: ..." note in addition to the target agent's system
	// prompt — deliberately trigger-specific (a Code Review verdict and a
	// weekly pattern review need different framing), so they are not byte-
	// identical to MENTION_DISCIPLINE and can't be collapsed into it without
	// losing that nuance. What CAN drift silently is the *set* of triggers
	// carrying the note — an edit that accidentally drops the line from a
	// trigger's actionPrompt (or a new trigger that needed one but didn't get
	// it) would otherwise ship unnoticed. This test locks that set so any
	// change is a deliberate, reviewed diff instead of silent drift.
	it('locks the set of triggers whose actionPrompt carries a mention-discipline note', () => {
		const triggersWithNote = DEVELOPMENT_TRIGGERS.filter((t) =>
			t.actionPrompt.includes('Mention discipline:'),
		).map((t) => t.name)

		expect(triggersWithNote).toEqual([
			'Task In Review → Code Review',
			'Task Validated → CTO Validation',
			'Task Done → Drive Next',
			'Daily Workspace Observation',
			'Daily Insight Curation',
			'Daily Code Review Analysis',
			'Weekly Insight Pattern Review',
			'Daily CTO Validation Analysis',
		])
	})
})
