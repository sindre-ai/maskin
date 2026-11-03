import { getAgentPictogram, getAgentTeam } from '@/lib/agent-pictogram'
import { describe, expect, it } from 'vitest'

describe('getAgentTeam', () => {
	it('uses the known team for a known agent name', () => {
		expect(getAgentTeam('SEO Writer')).toBe('Content')
		expect(getAgentTeam('Chief of Staff')).toBe('Operations')
	})

	it('reads the team from keywords in an unknown name', () => {
		expect(getAgentTeam('Invoice Chaser')).toBe('Finance')
		expect(getAgentTeam('Contract Reviewer')).toBe('Legal')
	})

	it('matches whole words, so Content Editor and Credit Analyst are not Video', () => {
		expect(getAgentTeam('Content Editor')).toBe('Content')
		expect(getAgentTeam('Credit Analyst')).toBe('Operations')
		expect(getAgentTeam('Video Editor')).toBe('Video')
	})

	it('reads the craft before the seniority word', () => {
		expect(getAgentTeam('Lead Developer')).toBe('Development')
		expect(getAgentTeam('Support Lead')).toBe('Support')
		expect(getAgentTeam('Lead Qualifier')).toBe('Sales')
	})

	it('ignores a bracketed qualifier', () => {
		expect(getAgentTeam('Planner (Sales)')).toBe('Operations')
	})

	it('falls back to Operations for an unrecognised or empty name', () => {
		expect(getAgentTeam('Zed')).toBe('Operations')
		expect(getAgentTeam('')).toBe('Operations')
	})
})

describe('getAgentPictogram', () => {
	it('returns the same pictogram for the same name', () => {
		expect(getAgentPictogram('SEO Researcher')).toEqual(getAgentPictogram('SEO Researcher'))
	})

	it('matches the prototype for SEO Researcher (Marketing, crescent)', () => {
		const result = getAgentPictogram('SEO Researcher')
		expect(result.team).toBe('Marketing')
		expect(result.variant).toBe(4)
	})

	it('always yields a mark and a token tint', () => {
		for (const name of ['A', 'Qualifier', 'Video Maker', '  x  ']) {
			const result = getAgentPictogram(name)
			expect(result.shapes.length).toBeGreaterThan(0)
			expect(result.tintClass).toContain('var(--st-')
		}
	})
})
