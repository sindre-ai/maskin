import { describe, expect, it } from 'vitest'
import {
	buildSignupOnboardingContext,
	buildSignupWelcomeMessage,
} from '../../services/signup-welcome-chat'

const BANNED = /\b(agents?|models?|prompts?|loops?|kpis?|mcp|integrations?|workflows?|llm)\b/i

describe('sign-up chat texts keep the voice rule', () => {
	it('welcome has no tech words, with and without an organization', () => {
		expect(buildSignupWelcomeMessage('Anna', 'Nordic Bakery')).not.toMatch(BANNED)
		expect(buildSignupWelcomeMessage('there')).not.toMatch(BANNED)
	})

	it('welcome names the person and ends on one question', () => {
		const text = buildSignupWelcomeMessage('Anna', 'Nordic Bakery')
		expect(text).toContain('Hi Anna')
		expect(text).toContain('Nordic Bakery')
		expect(text.trim().endsWith('?')).toBe(true)
	})

	it('briefing no longer tells the Chief of Staff to suggest an agent, a loop or an integration', () => {
		const text = buildSignupOnboardingContext({ name: 'Anna', knowledgeObjectId: 'k-1' })
		expect(text).toContain('first-chat script')
		expect(text).not.toMatch(/suggest concrete first steps/i)
		expect(text).not.toMatch(/\b(loop|integration)\b/i)
	})
})
