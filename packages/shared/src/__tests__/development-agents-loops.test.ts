import { describe, expect, it } from 'vitest'
import { DEVELOPMENT_AGENTS, DEVELOPMENT_TRIGGERS } from '../templates/development-agents'

const LOOP_STATUSES = ['holding', 'at-risk', 'breached'] as const
const LOOP_METADATA_FIELDS = ['floor', 'cadence', 'source_bet_id', 'last_breach_at'] as const

function findAgent($id: string) {
	const agent = DEVELOPMENT_AGENTS.find((a) => a.$id === $id)
	if (!agent) throw new Error(`Agent ${$id} not found`)
	return agent
}

function agentSurface($id: string): string {
	const agent = findAgent($id)
	return [agent.systemPrompt, ...(agent.skills ?? []).map((s) => s.content)].join('\n')
}

describe('development agents — loops awareness', () => {
	describe('Strategist', () => {
		const surface = agentSurface('strategist')

		it('teaches that succeeded bets codifying a standing capability graduate to a Loop, not live', () => {
			expect(surface).toMatch(/graduat/i)
			expect(surface).toContain("type: 'loop'")
			for (const status of LOOP_STATUSES) {
				expect(surface).toContain(status)
			}
		})

		it('names every loop metadata field the graduation proposal must set', () => {
			for (const field of LOOP_METADATA_FIELDS) {
				expect(surface).toContain(field)
			}
		})

		it('describes provenance via the derived_from edge, not a metadata field', () => {
			expect(surface).toContain('derived_from')
		})

		it('is explicit that auto-graduation is out — humans approve', () => {
			expect(surface).toMatch(/auto-graduation is out|Auto-graduation is out/)
			expect(surface).toMatch(/human/i)
		})

		it("reads loops with type='loop', never metadata_eq", () => {
			expect(surface).toContain("type='loop'")
			expect(surface).not.toContain("metadata_eq('is_loop'")
		})
	})

	describe('Workspace Coach (Chief of Staff briefing surface)', () => {
		const surface = agentSurface('workspace_coach')

		it('teaches that at-risk / breached loops are briefing-worthy alongside stalled bets', () => {
			expect(surface).toMatch(/Loop/)
			expect(surface).toContain('at-risk')
			expect(surface).toContain('breached')
			expect(surface).toMatch(/stalled bet/i)
		})

		it('names every loop metadata field the coach reports on', () => {
			for (const field of LOOP_METADATA_FIELDS) {
				expect(surface).toContain(field)
			}
		})

		it('describes provenance via the derived_from edge, not a metadata field', () => {
			expect(surface).toContain('derived_from')
		})

		it("filters loops with type='loop', never metadata_eq", () => {
			expect(surface).toContain("type='loop'")
			expect(surface).not.toMatch(/metadata_eq\(['"]is_loop/)
		})

		it('teaches that holding loops are healthy — only at-risk / breached warrant an insight', () => {
			expect(surface).toContain('holding')
			expect(surface).toMatch(/holding.*(healthy|not briefing-worthy|NOT briefing-worthy)/is)
		})
	})
})

describe('development triggers — loops health scan', () => {
	const scan = DEVELOPMENT_TRIGGERS.find((t) => t.name === 'Daily Loop Health Scan')

	it('registers the Daily Loop Health Scan trigger', () => {
		expect(scan).toBeDefined()
	})

	it('runs as a cron trigger against the workspace_coach', () => {
		expect(scan?.type).toBe('cron')
		expect(scan?.targetActor$id).toBe('workspace_coach')
		expect(scan?.enabled).toBe(true)
		expect(scan?.config.expression).toMatch(/^\S+ \S+ \S+ \S+ \S+$/)
	})

	it("reads loops with type='loop' and forbids metadata_eq filtering", () => {
		const prompt = scan?.actionPrompt ?? ''
		expect(prompt).toContain("type='loop'")
		expect(prompt).toMatch(/never.*metadata_eq/i)
	})

	it('stamps metadata.last_breach_at when the floor is missed inside the cadence window', () => {
		const prompt = scan?.actionPrompt ?? ''
		expect(prompt).toContain('last_breach_at')
		expect(prompt).toContain('floor')
		expect(prompt).toContain('cadence')
	})

	it('mentions every loop status the scan can propose transitions between', () => {
		for (const status of LOOP_STATUSES) {
			expect(scan?.actionPrompt).toContain(status)
		}
	})

	it('does not create Loop objects itself — graduation stays with humans', () => {
		expect(scan?.actionPrompt).toMatch(/never create a `type: 'loop'` object/i)
	})
})
