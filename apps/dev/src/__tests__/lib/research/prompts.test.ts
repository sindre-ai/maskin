import { SEARCH_DATA_USE_RULE } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import {
	LEAD_SYSTEM_PROMPT,
	RESEARCHER_SYSTEM_PROMPT,
	WRITER_SYSTEM_PROMPT,
} from '../../../lib/research/prompts'
import { SOURCE_QUALITY_RULES } from '../../../lib/research/source-quality'

// Spec 7.9, word for word. A change here is a change to the CTO's ruling.
const RULE_TEXT =
	'Search queries go to a third-party provider that may keep and train on them. Write queries about the public topic only. Never include a client name, contact name, deal, customer data or anything copied from a private workspace object. For a client-specific question, do not use this tool.'

describe('the search data-use rule', () => {
	it('is the text the CTO ruled on', () => {
		expect(SEARCH_DATA_USE_RULE).toBe(RULE_TEXT)
	})

	it('is in the lead prompt', () => {
		expect(LEAD_SYSTEM_PROMPT).toContain(RULE_TEXT)
	})

	it('is in the researcher prompt', () => {
		expect(RESEARCHER_SYSTEM_PROMPT).toContain(RULE_TEXT)
	})
})

describe('the source-quality rules', () => {
	it('are in the lead, researcher and writer prompts', () => {
		for (const prompt of [LEAD_SYSTEM_PROMPT, RESEARCHER_SYSTEM_PROMPT, WRITER_SYSTEM_PROMPT]) {
			expect(prompt).toContain(SOURCE_QUALITY_RULES)
		}
	})
})
