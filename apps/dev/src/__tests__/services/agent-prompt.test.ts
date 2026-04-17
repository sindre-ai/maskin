import { KNOWLEDGE_NUDGES } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import { buildAgentSystemPrompt } from '../../services/agent-prompt'

describe('buildAgentSystemPrompt', () => {
	it('returns the agent system prompt unchanged when knowledge module is not enabled', () => {
		const out = buildAgentSystemPrompt('You are Bet Planner.', { enabled_modules: ['work'] })
		expect(out).toBe('You are Bet Planner.')
	})

	it('appends KNOWLEDGE_NUDGES when the workspace has the knowledge module enabled', () => {
		const out = buildAgentSystemPrompt('You are Bet Planner.', {
			enabled_modules: ['work', 'knowledge'],
		})
		expect(out.startsWith('You are Bet Planner.')).toBe(true)
		expect(out.endsWith(KNOWLEDGE_NUDGES)).toBe(true)
	})

	it('falls back to a default prompt when the agent has none', () => {
		const out = buildAgentSystemPrompt(null, { enabled_modules: ['work'] })
		expect(out).toBe('You are a helpful AI agent.')
	})

	it('handles missing workspace settings (defaults to work-only, no nudge)', () => {
		const out = buildAgentSystemPrompt('You are Bet Planner.', null)
		expect(out).toBe('You are Bet Planner.')
		expect(out.includes(KNOWLEDGE_NUDGES)).toBe(false)
	})
})
