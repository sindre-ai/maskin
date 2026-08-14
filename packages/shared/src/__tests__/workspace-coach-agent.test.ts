import { describe, expect, it } from 'vitest'
import { SIGNUP_FIRST_BET_DRAFT_SOURCE } from '../schemas/signup-capture'
import { DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT } from '../templates/workspace-coach-agent'

describe('DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT — T4 signup-driven promotions section', () => {
	it('adds a dedicated sweep step for signup-driven bet promotions', () => {
		expect(DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT).toContain(
			'Signup-driven bet promotions (batched — always-notify-Sebastian lane)',
		)
	})

	it('filters the sweep by metadata.source = signup_first_bet_draft', () => {
		expect(DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT).toContain(
			`metadata.source = ${SIGNUP_FIRST_BET_DRAFT_SOURCE}`,
		)
	})

	it('scopes the window to the last 24 hours on a UTC day boundary', () => {
		expect(DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT).toContain('last 24 hours')
		expect(DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT).toContain('UTC day boundary')
	})

	it('names the workspace-standard link format and the get_objects url field', () => {
		expect(DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT).toContain('workspace-standard link format')
		expect(DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT).toContain('[title](<url>)')
		expect(DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT).toContain('get_objects')
	})

	it('lists the workspace name, bet title, and links to both bet and workspace per entry', () => {
		const section = DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT.split(
			'Signup-driven bet promotions',
		)[1]
		expect(section).toBeDefined()
		// Non-null asserted above; scoped to the section that names each entry's shape.
		const s = section as string
		expect(s).toContain('workspace name')
		expect(s).toContain('bet title')
		expect(s).toContain('link to both')
	})

	it('omits the section entirely on a zero-signup day (no "None" placeholder)', () => {
		expect(DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT).toContain(
			'omit this section entirely — do not add a "None" placeholder',
		)
	})

	it('preserves existing per-bet digest behavior for non-signup promotion sources', () => {
		expect(DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT).toContain(
			'do not touch the section for other promotion sources',
		)
	})

	it('renders the signup section in the Slack message output block', () => {
		expect(DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT).toContain(
			'**New signup-driven bets (batched)**',
		)
		expect(DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT).toContain('omit this section if empty')
	})

	it('keeps the existing six human-action sweeps intact', () => {
		expect(DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT).toContain('**Status changes by humans**')
		expect(DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT).toContain('**Comments by humans**')
		expect(DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT).toContain('**@mentions of founders**')
		expect(DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT).toContain('**New objects created by humans**')
		expect(DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT).toContain('**Approvals and overrides**')
		expect(DAILY_HUMAN_ACTIONS_DIGEST_ACTION_PROMPT).toContain(
			'**Open threads needing human response**',
		)
	})
})
