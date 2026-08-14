import { describe, expect, it } from 'vitest'
import {
	CAPABILITY_LEVEL_THRESHOLDS,
	CAPABILITY_RUBRIC,
	critiqueSystemPrompt,
	expertiseScoreFromCritique,
	levelForScore,
	scoreAgentCapability,
} from '../capability/index'
import type { AgentCapabilitySnapshot, McpServerLike } from '../capability/index'
import { DEVELOPMENT_AGENTS, DEVELOPMENT_TRIGGERS } from '../templates/development-agents'

function countTriggersFor($id: string): number {
	return DEVELOPMENT_TRIGGERS.filter((t) => t.targetActor$id === $id).length
}

// Env keys a fully-provisioned dev workspace would expose to the container:
// integration-issued tokens plus the maskin/browser system vars. Used only in
// the calibration test so seed agents aren't penalised for referencing
// integrations that we consider "connected" during scoring.
const CALIBRATED_ENV_KEYS = [
	'MASKIN_API_URL',
	'MASKIN_API_KEY',
	'MASKIN_WORKSPACE_ID',
	'GITHUB_TOKEN',
	'SLACK_TOKEN',
	'EXA_API_KEY',
	'BROWSER_CDP_URL',
	'SINDRE_API_KEY',
	'SUPADATA_API_TOKEN',
]

function snapshotFromSeed($id: string): AgentCapabilitySnapshot {
	const seed = DEVELOPMENT_AGENTS.find((a) => a.$id === $id)
	if (!seed) throw new Error(`missing seed: ${$id}`)
	const mcpServers = (seed.tools as { mcpServers?: Record<string, McpServerLike> } | undefined)
		?.mcpServers
	const model = (seed.llmConfig as { model?: string } | undefined)?.model
	return {
		systemPrompt: seed.systemPrompt,
		description: seed.description ?? null,
		mcpServers: mcpServers ?? null,
		skillCount: seed.skills?.length ?? 0,
		invalidSkillCount: 0,
		triggerCount: countTriggersFor($id),
		inLoop: false,
		model: model ?? null,
		llmProvider: 'anthropic',
		memoryKeys: [],
		activeIntegrationProviders: ['github', 'slack', 'exa'],
		availableEnvKeys: CALIBRATED_ENV_KEYS,
	}
}

describe('critiqueSystemPrompt', () => {
	it('returns isEmpty for null/undefined/whitespace', () => {
		for (const value of [null, undefined, '', '   \n\t  ']) {
			const c = critiqueSystemPrompt(value)
			expect(c.isEmpty).toBe(true)
			expect(c.length).toBe(0)
			expect(c.headingCount).toBe(0)
			expect(c.hasExamples).toBe(false)
		}
	})

	it('counts markdown headings from level 1 through 6', () => {
		const draft = '# Top\n\n## Second\n\n### Third\n\nBody text.'
		const c = critiqueSystemPrompt(draft)
		expect(c.headingCount).toBe(3)
	})

	it('detects examples via prose cues and fenced code blocks', () => {
		expect(critiqueSystemPrompt('For example, do X.').hasExamples).toBe(true)
		expect(critiqueSystemPrompt('e.g. call foo').hasExamples).toBe(true)
		expect(critiqueSystemPrompt('```ts\nfoo()\n```').hasExamples).toBe(true)
		expect(critiqueSystemPrompt('A generic description with no examples.').hasExamples).toBe(false)
	})

	it('detects decision framework via numbered lists and cue phrases', () => {
		expect(critiqueSystemPrompt('1. Do this\n2. Then that').hasDecisionFramework).toBe(true)
		expect(critiqueSystemPrompt('When triggered, follow these steps.').hasDecisionFramework).toBe(
			true,
		)
	})

	it('scales expertise 0..5 by length + structure + examples', () => {
		expect(expertiseScoreFromCritique(critiqueSystemPrompt(''))).toBe(0)
		expect(expertiseScoreFromCritique(critiqueSystemPrompt('short.'))).toBe(1)
		const mid = 'You are a helper. '.repeat(20)
		expect(expertiseScoreFromCritique(critiqueSystemPrompt(mid))).toBe(2)
		const structured = `# Role\nYou are ${'x '.repeat(400)}\n\n## Scope\n${'y '.repeat(200)}\n\n## Steps\n1. Do it\n2. Ship it`
		expect(expertiseScoreFromCritique(critiqueSystemPrompt(structured))).toBe(4)
		const strong = `# Role\nYou are the strategist. ${'context '.repeat(200)}\n\n## Scope\n${'text '.repeat(200)}\n\n## Steps\n1. Do it\n\n## Example\n\`\`\`ts\nfoo()\n\`\`\``
		expect(expertiseScoreFromCritique(critiqueSystemPrompt(strong))).toBe(5)
	})
})

describe('levelForScore', () => {
	it('maps every threshold band to the correct level', () => {
		expect(levelForScore(0)).toBe('novice')
		expect(levelForScore(19)).toBe('novice')
		expect(levelForScore(20)).toBe('apprentice')
		expect(levelForScore(39)).toBe('apprentice')
		expect(levelForScore(40)).toBe('practitioner')
		expect(levelForScore(64)).toBe('practitioner')
		expect(levelForScore(65)).toBe('expert')
		expect(levelForScore(84)).toBe('expert')
		expect(levelForScore(85)).toBe('master')
		expect(levelForScore(100)).toBe('master')
	})

	it('clamps out-of-range inputs to a valid level', () => {
		expect(levelForScore(-10)).toBe('novice')
		expect(levelForScore(150)).toBe('master')
	})
})

describe('CAPABILITY_RUBRIC', () => {
	it('sums to 100 across the five dimensions', () => {
		const total = CAPABILITY_RUBRIC.reduce((sum, entry) => sum + entry.weight, 0)
		expect(total).toBe(100)
		expect(CAPABILITY_RUBRIC.map((r) => r.key).sort()).toEqual(
			['autonomy', 'connectors', 'context', 'expertise', 'skills'].sort(),
		)
	})

	it('level thresholds cover the full 0..100 range with no gaps', () => {
		const mins = CAPABILITY_LEVEL_THRESHOLDS.map((t) => t.min).sort((a, b) => a - b)
		expect(mins[0]).toBe(0)
		expect(mins[mins.length - 1]).toBe(85)
	})
})

describe('scoreAgentCapability — calibration anchors', () => {
	it('bare "You are a bot." agent scores Novice with ≥3 actionable gaps', () => {
		const result = scoreAgentCapability({ systemPrompt: 'You are a bot.' })
		expect(result.overall.level).toBe('novice')
		expect(result.overall.score).toBeLessThanOrEqual(19)
		expect(result.topGaps.length).toBeGreaterThanOrEqual(3)
		for (const gap of result.topGaps) {
			expect(gap.action.length).toBeGreaterThan(0)
			expect(gap.detail.length).toBeGreaterThan(0)
		}
	})

	it('bare snapshot with no system prompt at all still returns a valid result', () => {
		const result = scoreAgentCapability({ systemPrompt: null })
		expect(result.overall.level).toBe('novice')
		expect(result.dimensions).toHaveLength(5)
	})

	it('Strategist seed scores Expert+ (≥65) in a fully-connected workspace', () => {
		const result = scoreAgentCapability(snapshotFromSeed('strategist'))
		expect(result.overall.score).toBeGreaterThanOrEqual(65)
		expect(['expert', 'master']).toContain(result.overall.level)
		expect(result.unresolvedPlaceholders).toEqual([])
	})

	it('Workspace Coach seed scores Expert+ (≥65) in a fully-connected workspace', () => {
		const result = scoreAgentCapability(snapshotFromSeed('workspace_coach'))
		expect(result.overall.score).toBeGreaterThanOrEqual(65)
		expect(['expert', 'master']).toContain(result.overall.level)
	})
})

describe('scoreAgentCapability — placeholder-driven Connectors cap', () => {
	const server: McpServerLike = {
		type: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-github'],
		env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' },
	}

	it('caps Connectors at 2/5 when placeholders are unresolved', () => {
		const result = scoreAgentCapability({
			systemPrompt: 'x'.repeat(3000),
			mcpServers: { github: server, slack: server, exa: server },
			availableEnvKeys: [],
		})
		const connectors = result.dimensions.find((d) => d.key === 'connectors')
		expect(connectors?.score).toBeLessThanOrEqual(2)
		expect(result.unresolvedPlaceholders).toEqual(['GITHUB_TOKEN'])
		const hint = result.topGaps.find((g) => g.toolHint === 'connect_integration')
		expect(hint).toBeDefined()
	})

	it('scans header values on http MCP servers, not just stdio env', () => {
		const httpServer: McpServerLike = {
			type: 'http',
			url: 'https://mcp.example.com',
			headers: { Authorization: 'Bearer ${SECRET_TOKEN}' },
		}
		const result = scoreAgentCapability({
			systemPrompt: 'x'.repeat(3000),
			mcpServers: { example: httpServer },
			availableEnvKeys: [],
		})
		expect(result.unresolvedPlaceholders).toContain('SECRET_TOKEN')
	})

	it('leaves Connectors uncapped when every placeholder is available', () => {
		const result = scoreAgentCapability({
			systemPrompt: 'x'.repeat(3000),
			mcpServers: { github: server, slack: server },
			availableEnvKeys: ['GITHUB_TOKEN'],
		})
		expect(result.unresolvedPlaceholders).toEqual([])
		const connectors = result.dimensions.find((d) => d.key === 'connectors')
		expect(connectors?.score).toBeGreaterThan(2)
	})

	it('does not count the workspace-baseline `maskin` server toward Connectors', () => {
		const result = scoreAgentCapability({
			systemPrompt: 'x'.repeat(3000),
			mcpServers: {
				maskin: { type: 'http', url: 'https://api', headers: {} },
			},
			availableEnvKeys: [],
		})
		const connectors = result.dimensions.find((d) => d.key === 'connectors')
		expect(connectors?.score).toBe(0)
	})
})

describe('scoreAgentCapability — Skills, Context, Autonomy edges', () => {
	it('penalises invalid attached skills by one point', () => {
		const clean = scoreAgentCapability({
			systemPrompt: 'x',
			skillCount: 2,
			invalidSkillCount: 0,
		})
		const dirty = scoreAgentCapability({
			systemPrompt: 'x',
			skillCount: 2,
			invalidSkillCount: 1,
		})
		const cleanScore = clean.dimensions.find((d) => d.key === 'skills')?.score ?? 0
		const dirtyScore = dirty.dimensions.find((d) => d.key === 'skills')?.score ?? 0
		expect(dirtyScore).toBe(cleanScore - 1)
	})

	it('memory keys bump Context 0 → 2, then 2 → 3 at three keys', () => {
		const none = scoreAgentCapability({ systemPrompt: 'x' })
		const one = scoreAgentCapability({ systemPrompt: 'x', memoryKeys: ['a'] })
		const three = scoreAgentCapability({ systemPrompt: 'x', memoryKeys: ['a', 'b', 'c'] })
		expect(none.dimensions.find((d) => d.key === 'context')?.score).toBe(0)
		expect(one.dimensions.find((d) => d.key === 'context')?.score).toBe(2)
		expect(three.dimensions.find((d) => d.key === 'context')?.score).toBe(3)
	})

	it('being installed in a loop guarantees Autonomy ≥3 even with zero triggers', () => {
		const looped = scoreAgentCapability({ systemPrompt: 'x', triggerCount: 0, inLoop: true })
		const autonomy = looped.dimensions.find((d) => d.key === 'autonomy')?.score ?? 0
		expect(autonomy).toBeGreaterThanOrEqual(3)
	})

	it('trigger count 1 → 3, 2 → 4, 3+ → 5', () => {
		const grades = [0, 1, 2, 3, 4].map((n) => {
			const result = scoreAgentCapability({ systemPrompt: 'x', triggerCount: n })
			return result.dimensions.find((d) => d.key === 'autonomy')?.score ?? 0
		})
		expect(grades).toEqual([0, 3, 4, 5, 5])
	})
})

describe('scoreAgentCapability — gap ranking', () => {
	it('prioritises higher-weight × higher-headroom gaps first', () => {
		const result = scoreAgentCapability({
			systemPrompt: null,
			skillCount: 0,
			triggerCount: 0,
		})
		expect(result.topGaps[0]?.dimension).toBe('expertise')
	})

	it('returns at most 5 gaps', () => {
		const result = scoreAgentCapability({ systemPrompt: null })
		expect(result.topGaps.length).toBeLessThanOrEqual(5)
	})
})
