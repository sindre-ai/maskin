import { describe, expect, it } from 'vitest'
import {
	type AgentCapabilitySnapshot,
	CAPABILITY_RUBRIC,
	critiqueSystemPrompt,
	findUnresolvedPlaceholders,
	levelFor,
	scoreAgentCapability,
} from '../capability/index'
import { DEVELOPMENT_AGENTS } from '../templates/development-agents'
import { WORKSPACE_COACH_DEFAULT } from '../templates/workspace-coach-agent'

function snapshot(overrides: Partial<AgentCapabilitySnapshot> = {}): AgentCapabilitySnapshot {
	return {
		systemPrompt: null,
		description: null,
		mcpServers: {},
		skillCount: 0,
		invalidSkillCount: 0,
		triggerCount: 0,
		inLoop: false,
		model: null,
		llmProvider: null,
		memoryKeys: 0,
		activeIntegrationProviders: [],
		availableEnvKeys: [],
		...overrides,
	}
}

function dimension(result: ReturnType<typeof scoreAgentCapability>, key: string) {
	const dim = result.dimensions.find((d) => d.key === key)
	if (!dim) throw new Error(`missing dimension ${key}`)
	return dim
}

// Calibration anchors: seeds whose prompts are the "fully configured" reference.
// insight_curator is deliberately excluded — its seed prompt is a short,
// sectionless paragraph and the rubric scoring it low is the feature working.
function anchorAgents() {
	return DEVELOPMENT_AGENTS.filter((a) => a.$id !== 'insight_curator')
}

describe('critiqueSystemPrompt', () => {
	it('fails every criterion on an empty draft', () => {
		const criteria = critiqueSystemPrompt('')
		expect(criteria).toHaveLength(8)
		expect(criteria.every((c) => !c.pass)).toBe(true)
		for (const c of criteria) expect(c.detail.length).toBeGreaterThan(10)
	})

	it('passes the core criteria on every anchor template agent prompt (calibration anchor)', () => {
		// Core = the criteria expertise scoring gates on. Not every seed carries
		// stance/examples language — that's what caps some at 4 instead of 5.
		const core = new Set(['role_identity', 'decision_framework', 'structure', 'length'])
		for (const agent of anchorAgents()) {
			const criteria = critiqueSystemPrompt(agent.systemPrompt)
			const failed = criteria.filter((c) => !c.pass && core.has(c.id)).map((c) => c.id)
			expect(failed, `${agent.name} failed: ${failed.join(', ')}`).toEqual([])
		}
	})

	it('returns revision instructions for a thin generic prompt', () => {
		const criteria = critiqueSystemPrompt('Help the user with marketing tasks.')
		const structure = criteria.find((c) => c.id === 'structure')
		expect(structure?.pass).toBe(false)
		const stance = criteria.find((c) => c.id === 'stance')
		expect(stance?.pass).toBe(false)
	})
})

describe('scoreAgentCapability — expertise', () => {
	it('scores 0 with no system prompt', () => {
		const result = scoreAgentCapability(snapshot())
		expect(dimension(result, 'expertise').score).toBe(0)
	})

	it('scores 1 for a one-liner', () => {
		const result = scoreAgentCapability(snapshot({ systemPrompt: 'You are a helpful marketer.' }))
		expect(dimension(result, 'expertise').score).toBe(1)
	})

	it('scores 4–5 for every anchor template agent (calibration anchor)', () => {
		for (const agent of anchorAgents()) {
			const result = scoreAgentCapability(snapshot({ systemPrompt: agent.systemPrompt }))
			const score = dimension(result, 'expertise').score
			expect(score, `${agent.name} scored ${score}`).toBeGreaterThanOrEqual(4)
		}
	})

	it('scores 4+ for the workspace coach default prompt', () => {
		const result = scoreAgentCapability(
			snapshot({ systemPrompt: WORKSPACE_COACH_DEFAULT.systemPrompt }),
		)
		expect(dimension(result, 'expertise').score).toBeGreaterThanOrEqual(4)
	})
})

describe('scoreAgentCapability — skills', () => {
	it('maps skill counts onto the scale', () => {
		expect(dimension(scoreAgentCapability(snapshot()), 'skills').score).toBe(0)
		expect(dimension(scoreAgentCapability(snapshot({ skillCount: 1 })), 'skills').score).toBe(2)
		expect(dimension(scoreAgentCapability(snapshot({ skillCount: 3 })), 'skills').score).toBe(4)
		expect(dimension(scoreAgentCapability(snapshot({ skillCount: 5 })), 'skills').score).toBe(5)
	})

	it('docks a point when attached skills are invalid', () => {
		const result = scoreAgentCapability(snapshot({ skillCount: 3, invalidSkillCount: 1 }))
		const dim = dimension(result, 'skills')
		expect(dim.score).toBe(3)
		expect(dim.gaps.some((g) => g.detail.includes('failed validation'))).toBe(true)
	})
})

describe('scoreAgentCapability — connectors', () => {
	it('ignores the maskin platform preset', () => {
		const result = scoreAgentCapability(snapshot({ mcpServers: { maskin: { type: 'http' } } }))
		const dim = dimension(result, 'connectors')
		expect(dim.score).toBe(0)
		expect(dim.gaps.some((g) => g.action === 'add_mcp_server')).toBe(true)
	})

	it('awards the resolution bonus when all placeholders resolve', () => {
		const result = scoreAgentCapability(
			snapshot({
				mcpServers: { slack: { env: { SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}' } } },
				availableEnvKeys: ['SLACK_BOT_TOKEN'],
			}),
		)
		expect(dimension(result, 'connectors').score).toBe(3)
		expect(result.unresolvedPlaceholders).toEqual([])
	})

	it('caps at 2 and emits gaps when a placeholder cannot resolve', () => {
		const result = scoreAgentCapability(
			snapshot({
				mcpServers: {
					slack: { env: { SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}' } },
					github: { env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' } },
					exa: { env: { EXA_API_KEY: 'literal-key' } },
				},
				availableEnvKeys: ['GITHUB_TOKEN'],
			}),
		)
		const dim = dimension(result, 'connectors')
		expect(dim.score).toBe(2)
		expect(result.unresolvedPlaceholders).toEqual([
			{ server: 'slack', envKey: 'SLACK_BOT_TOKEN', placeholder: '${SLACK_BOT_TOKEN}' },
		])
		expect(dim.gaps.some((g) => g.action === 'connect_integration')).toBe(true)
	})

	it('finds placeholders in headers, args, and urls', () => {
		const unresolved = findUnresolvedPlaceholders(
			snapshot({
				mcpServers: {
					linear: {
						type: 'http',
						url: 'https://mcp.linear.app/mcp',
						headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' },
					},
					custom: { command: 'npx', args: ['-y', 'some-server', '--token', '${CUSTOM_TOKEN}'] },
				},
			}),
		)
		expect(unresolved.map((u) => u.envKey).sort()).toEqual(['CUSTOM_TOKEN', 'LINEAR_TOKEN'])
	})
})

describe('scoreAgentCapability — context and autonomy', () => {
	it('accumulates context points and caps at 5', () => {
		const result = scoreAgentCapability(
			snapshot({
				memoryKeys: 3,
				description: 'Handles growth outreach',
				model: 'claude-sonnet-4-6',
				llmProvider: 'anthropic',
			}),
		)
		expect(dimension(result, 'context').score).toBe(5)
	})

	it('guarantees autonomy ≥3 when the agent runs in a loop', () => {
		const result = scoreAgentCapability(snapshot({ inLoop: true }))
		expect(dimension(result, 'autonomy').score).toBe(3)
	})

	it('scores autonomy from trigger count', () => {
		expect(dimension(scoreAgentCapability(snapshot({ triggerCount: 1 })), 'autonomy').score).toBe(3)
		expect(dimension(scoreAgentCapability(snapshot({ triggerCount: 3 })), 'autonomy').score).toBe(5)
	})
})

describe('scoreAgentCapability — overall', () => {
	it('rates a bare name-only agent as novice with actionable top gaps', () => {
		const result = scoreAgentCapability(snapshot())
		expect(result.overall.level).toBe('novice')
		expect(result.overall.score).toBeLessThan(20)
		expect(result.topGaps.length).toBe(5)
		// The heaviest dimension (expertise, weight 35) must lead the gap list.
		expect(result.topGaps[0].action).toBe('expand_system_prompt')
		for (const gap of result.topGaps) expect(gap.toolHint).toBeTruthy()
	})

	it('rates a fully configured template-grade agent expert or better (calibration anchor)', () => {
		const strategist = DEVELOPMENT_AGENTS.find((a) => a.$id === 'strategist')
		if (!strategist) throw new Error('strategist seed missing')
		const result = scoreAgentCapability(
			snapshot({
				systemPrompt: strategist.systemPrompt,
				description: 'Shapes and runs bets',
				mcpServers: {
					maskin: { type: 'http' },
					slack: { env: { SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}' } },
					github: { env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' } },
				},
				skillCount: strategist.skills?.length ?? 0,
				triggerCount: 2,
				model: 'claude-sonnet-4-6',
				llmProvider: 'anthropic',
				memoryKeys: 3,
				activeIntegrationProviders: ['slack', 'github'],
				availableEnvKeys: ['SLACK_BOT_TOKEN', 'GITHUB_TOKEN'],
			}),
		)
		expect(result.overall.score).toBeGreaterThanOrEqual(65)
		expect(['expert', 'master']).toContain(result.overall.level)
	})

	it('score rises monotonically as configuration is added', () => {
		const bare = scoreAgentCapability(snapshot()).overall.score
		const withPrompt = scoreAgentCapability(
			snapshot({ systemPrompt: DEVELOPMENT_AGENTS[0].systemPrompt }),
		).overall.score
		const withSkills = scoreAgentCapability(
			snapshot({ systemPrompt: DEVELOPMENT_AGENTS[0].systemPrompt, skillCount: 2 }),
		).overall.score
		expect(withPrompt).toBeGreaterThan(bare)
		expect(withSkills).toBeGreaterThan(withPrompt)
	})

	it('level thresholds match the rubric', () => {
		expect(levelFor(0)).toBe('novice')
		expect(levelFor(19)).toBe('novice')
		expect(levelFor(20)).toBe('apprentice')
		expect(levelFor(40)).toBe('practitioner')
		expect(levelFor(65)).toBe('expert')
		expect(levelFor(85)).toBe('master')
		expect(levelFor(100)).toBe('master')
	})

	it('weights sum to 100', () => {
		const total = Object.values(CAPABILITY_RUBRIC).reduce((sum, d) => sum + d.weight, 0)
		expect(total).toBe(100)
	})
})
