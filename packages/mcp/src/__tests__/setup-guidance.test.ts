import { describe, expect, it } from 'vitest'
import {
	KNOWN_PROVIDERS,
	type LoopCheckContext,
	type LoopInput,
	type LoopStep,
	checkActor,
	checkBet,
	checkLoop,
	findMentionedProviders,
	toNextSteps,
	toProseBlock,
} from '../setup-guidance'

const readyWorkspace = { hasLlmKey: true, hasClaudeOAuth: false }

function loop(fields: Partial<LoopInput> = {}): LoopInput {
	return {
		id: 'loop-1',
		entryCondition: 'When an insight is qualified',
		closeCondition: 'When the bet ships',
		...fields,
	}
}

function step(fields: Partial<LoopStep> = {}): LoopStep {
	return {
		triggerId: fields.triggerId ?? 't1',
		triggerName: fields.triggerName ?? 'process items',
		triggerActionPrompt: fields.triggerActionPrompt ?? 'Do the work',
		triggerConfig: fields.triggerConfig ?? { expression: '0 * * * *' },
		agent:
			fields.agent === undefined
				? { id: 'a1', name: 'Worker', description: 'You are a worker.' }
				: fields.agent,
	}
}

function ctx(fields: Partial<LoopCheckContext> = {}): LoopCheckContext {
	return {
		connectedProviders: [],
		steps: [step()],
		memberCount: 3,
		...fields,
	}
}

describe('checkLoop — first-test fixture (bet DoD #8)', () => {
	it('produces steps_have_agents:fail (first) and connectors_connected:warn with connect_integration fix', () => {
		const steps: LoopStep[] = [
			step({ triggerId: 'agentless', agent: null }),
			step({
				triggerId: 'with-agent',
				agent: {
					id: 'analyst',
					name: 'Analyst',
					description: 'You are an analyst who queries PostHog for events.',
				},
			}),
		]
		const checks = checkLoop(loop(), ctx({ steps, connectedProviders: [], memberCount: 5 }))

		expect(checks[0].name).toBe('steps_have_agents')
		expect(checks[0].status).toBe('fail')

		const connectors = checks.find((c) => c.name === 'connectors_connected')
		expect(connectors).toBeDefined()
		expect(connectors?.status).toBe('warn')
		expect(connectors?.fix?.tool).toBe('connect_integration')
		expect(connectors?.fix?.args_hint.toLowerCase()).toContain('posthog')

		const prose = toProseBlock(checks)
		expect(prose).toMatch(/Ask the user/)
	})
})

describe('checkLoop — individual checks', () => {
	it('steps_have_agents fails when the loop has zero triggers', () => {
		const checks = checkLoop(loop(), ctx({ steps: [] }))
		expect(checks[0].name).toBe('steps_have_agents')
		expect(checks[0].status).toBe('fail')
	})

	it('steps_have_agents passes when every step has an agent', () => {
		const checks = checkLoop(loop(), ctx({ steps: [step(), step({ triggerId: 't2' })] }))
		expect(checks.find((c) => c.name === 'steps_have_agents')).toBeUndefined()
	})

	it('connectors_connected scans the trigger action_prompt independently of the agent prompt', () => {
		const checks = checkLoop(
			loop(),
			ctx({
				steps: [
					step({
						agent: { id: 'a1', name: 'a', description: 'Plain agent.' },
						triggerActionPrompt: 'Post an update to Slack when done.',
					}),
				],
				connectedProviders: [],
			}),
		)
		const c = checks.find((c) => c.name === 'connectors_connected')
		expect(c?.status).toBe('warn')
		expect(c?.fix?.args_hint.toLowerCase()).toContain('slack')
	})

	it('connectors_connected scans stringified trigger config', () => {
		const checks = checkLoop(
			loop(),
			ctx({
				steps: [
					step({
						agent: { id: 'a1', name: 'a', description: 'Plain agent.' },
						triggerActionPrompt: 'Do a thing.',
						triggerConfig: { entity_type: 'linear_issue' },
					}),
				],
				connectedProviders: [],
			}),
		)
		const c = checks.find((c) => c.name === 'connectors_connected')
		expect(c?.status).toBe('warn')
		expect(c?.fix?.args_hint.toLowerCase()).toContain('linear')
	})

	it('connectors_connected passes when the referenced provider is already connected', () => {
		const checks = checkLoop(
			loop(),
			ctx({
				steps: [
					step({
						agent: { id: 'a1', name: 'a', description: 'Query PostHog.' },
					}),
				],
				connectedProviders: ['posthog'],
			}),
		)
		expect(checks.find((c) => c.name === 'connectors_connected')).toBeUndefined()
	})

	it('has_members warns on empty loops', () => {
		const checks = checkLoop(loop(), ctx({ memberCount: 0 }))
		const c = checks.find((c) => c.name === 'has_members')
		expect(c?.status).toBe('warn')
	})

	it('conditions_set warns when either entry or close condition is missing', () => {
		const missingClose = checkLoop(loop({ closeCondition: null }), ctx())
		expect(missingClose.find((c) => c.name === 'conditions_set')?.status).toBe('warn')

		const empties = checkLoop(loop({ entryCondition: '   ', closeCondition: '' }), ctx())
		expect(empties.find((c) => c.name === 'conditions_set')?.status).toBe('warn')

		const bothSet = checkLoop(loop(), ctx())
		expect(bothSet.find((c) => c.name === 'conditions_set')).toBeUndefined()
	})
})

describe('priority ordering', () => {
	it('places fails before warns, then intent → agents → connectors → rest', () => {
		const checks = checkLoop(
			loop({ entryCondition: null, closeCondition: null }),
			ctx({
				steps: [
					step({ triggerId: 'a', agent: null }),
					step({
						triggerId: 'b',
						agent: { id: 'a1', name: 'a', description: 'GitHub things.' },
					}),
				],
				connectedProviders: [],
				memberCount: 0,
			}),
		)
		expect(checks.map((c) => c.name)).toEqual([
			'steps_have_agents', // fail
			'conditions_set', // warn — intent
			'connectors_connected', // warn — connectors
			'has_members', // warn — rest
		])
	})

	it('toNextSteps returns at most the requested count', () => {
		const checks = checkLoop(
			loop({ entryCondition: null, closeCondition: null }),
			ctx({
				steps: [step({ agent: null })],
				connectedProviders: [],
				memberCount: 0,
			}),
		)
		expect(toNextSteps(checks).length).toBe(3)
		expect(toNextSteps(checks, 1).length).toBe(1)
		expect(toNextSteps(checks, 0).length).toBe(0)
	})
})

describe('checkBet', () => {
	const fullContent = 'x'.repeat(200)

	it('applies to any object type, not just bets', () => {
		const checks = checkBet(
			{ id: 't1', type: 'task', status: 'todo', content: fullContent, driver: 'actor-1' },
			{ workspace: readyWorkspace, statusOrder: ['todo', 'done'] },
		)
		expect(checks.find((c) => c.name === 'driver_set')).toBeDefined()
	})

	describe('content_quality', () => {
		it('warns when content is missing', () => {
			const checks = checkBet(
				{ id: 'b1', type: 'bet', driver: 'actor-1' },
				{ workspace: readyWorkspace, statusOrder: [] },
			)
			const c = checks.find((c) => c.name === 'content_quality')
			expect(c?.status).toBe('warn')
			expect(c?.message).toMatch(/no content/)
		})

		it('warns when content is under 200 characters', () => {
			const checks = checkBet(
				{ id: 'b1', type: 'bet', content: 'short', driver: 'actor-1' },
				{ workspace: readyWorkspace, statusOrder: [] },
			)
			const c = checks.find((c) => c.name === 'content_quality')
			expect(c?.status).toBe('warn')
			expect(c?.message).toContain('5 characters')
		})

		it('does not warn when content is 200+ characters', () => {
			const checks = checkBet(
				{ id: 'b1', type: 'bet', content: fullContent, driver: 'actor-1' },
				{ workspace: readyWorkspace, statusOrder: [] },
			)
			expect(checks.find((c) => c.name === 'content_quality')).toBeUndefined()
		})
	})

	describe('driver_set', () => {
		it('warns to add a driver when none is set', () => {
			const checks = checkBet(
				{ id: 'b1', type: 'bet', content: fullContent },
				{ workspace: readyWorkspace, statusOrder: [] },
			)
			const c = checks.find((c) => c.name === 'driver_set')
			expect(c?.status).toBe('warn')
			expect(c?.message).toMatch(/no driver/)
		})

		it('warns to confirm the driver when one is set', () => {
			const checks = checkBet(
				{ id: 'b1', type: 'bet', content: fullContent, driver: 'actor-1' },
				{ workspace: readyWorkspace, statusOrder: [] },
			)
			const c = checks.find((c) => c.name === 'driver_set')
			expect(c?.status).toBe('warn')
			expect(c?.message).toContain('actor-1')
			expect(c?.message).toMatch(/confirm/)
		})
	})

	describe('status_progression', () => {
		it('asks whether to progress when status is the entry status', () => {
			const checks = checkBet(
				{ id: 'b1', type: 'bet', status: 'signal', content: fullContent, driver: 'actor-1' },
				{ workspace: readyWorkspace, statusOrder: ['signal', 'qualified', 'active'] },
			)
			const c = checks.find((c) => c.name === 'status_progression')
			expect(c?.status).toBe('warn')
			expect(c?.message).toContain('signal')
			expect(c?.message).toContain('qualified')
		})

		it('does not fire once the object is past the entry status', () => {
			const checks = checkBet(
				{ id: 'b1', type: 'bet', status: 'active', content: fullContent, driver: 'actor-1' },
				{ workspace: readyWorkspace, statusOrder: ['signal', 'qualified', 'active'] },
			)
			expect(checks.find((c) => c.name === 'status_progression')).toBeUndefined()
		})

		it('does not fire when there is no status order to progress along', () => {
			const checks = checkBet(
				{ id: 'b1', type: 'bet', status: 'signal', content: fullContent, driver: 'actor-1' },
				{ workspace: readyWorkspace, statusOrder: [] },
			)
			expect(checks.find((c) => c.name === 'status_progression')).toBeUndefined()
		})
	})
})

describe('checkActor', () => {
	it('produces no checks for non-agent actors', () => {
		expect(checkActor({ id: 'a1', name: 'A Human', type: 'human' })).toEqual([])
		expect(checkActor({ id: 'a1', name: 'A Human' })).toEqual([])
	})

	const fullPrompt = 'x'.repeat(200)

	it('warns on a missing or short system prompt', () => {
		const missing = checkActor({ id: 'a1', type: 'agent' })
		expect(missing.find((c) => c.name === 'system_prompt_quality')?.status).toBe('warn')

		const short = checkActor({ id: 'a1', type: 'agent', systemPrompt: 'short' })
		expect(short.find((c) => c.name === 'system_prompt_quality')?.status).toBe('warn')

		const full = checkActor({ id: 'a1', type: 'agent', systemPrompt: fullPrompt })
		expect(full.find((c) => c.name === 'system_prompt_quality')).toBeUndefined()
	})

	it('warns when no skills or only one skill are attached', () => {
		const none = checkActor({ id: 'a1', type: 'agent', systemPrompt: fullPrompt, skillCount: 0 })
		expect(none.find((c) => c.name === 'skills_attached')?.message).toMatch(/no skills/)

		const one = checkActor({ id: 'a1', type: 'agent', systemPrompt: fullPrompt, skillCount: 1 })
		expect(one.find((c) => c.name === 'skills_attached')?.message).toMatch(/only one skill/)

		const two = checkActor({ id: 'a1', type: 'agent', systemPrompt: fullPrompt, skillCount: 2 })
		expect(two.find((c) => c.name === 'skills_attached')).toBeUndefined()
	})

	it('warns when no MCP tools or only one are configured (excluding maskin)', () => {
		const none = checkActor({
			id: 'a1',
			type: 'agent',
			systemPrompt: fullPrompt,
			nonMaskinMcpServerCount: 0,
		})
		expect(none.find((c) => c.name === 'mcp_configured')?.message).toMatch(/no MCP tools/)

		const one = checkActor({
			id: 'a1',
			type: 'agent',
			systemPrompt: fullPrompt,
			nonMaskinMcpServerCount: 1,
		})
		expect(one.find((c) => c.name === 'mcp_configured')?.message).toMatch(/one MCP tool/)

		const two = checkActor({
			id: 'a1',
			type: 'agent',
			systemPrompt: fullPrompt,
			nonMaskinMcpServerCount: 2,
		})
		expect(two.find((c) => c.name === 'mcp_configured')).toBeUndefined()
	})

	it('always asks about a dry run for agents', () => {
		const checks = checkActor({
			id: 'a1',
			type: 'agent',
			systemPrompt: fullPrompt,
			skillCount: 2,
			nonMaskinMcpServerCount: 2,
		})
		expect(checks).toEqual([
			{
				name: 'dry_run_suggested',
				status: 'warn',
				message: expect.stringContaining('dry-run'),
				fix: expect.objectContaining({ tool: 'run_agent' }),
			},
		])
	})
})

describe('graceful degradation', () => {
	it('never throws when a step contains a circular config', () => {
		const circular: Record<string, unknown> = {}
		circular.self = circular
		const checks = checkLoop(
			loop(),
			ctx({ steps: [step({ triggerConfig: circular })], connectedProviders: [] }),
		)
		expect(Array.isArray(checks)).toBe(true)
	})

	it('never throws when statusOrder is empty', () => {
		expect(() =>
			checkBet(
				{ id: 'b1', type: 'bet', status: 'active' },
				{ workspace: readyWorkspace, statusOrder: [] },
			),
		).not.toThrow()
	})
})

describe('findMentionedProviders', () => {
	it('matches known provider names with word boundaries', () => {
		expect(findMentionedProviders('Query PostHog for events.')).toContain('posthog')
		expect(findMentionedProviders('slackline stunts')).not.toContain('slack')
	})

	it('is case-insensitive and returns canonical names', () => {
		expect(findMentionedProviders('POSTHOG')).toContain('posthog')
	})

	it('returns [] for empty input', () => {
		expect(findMentionedProviders('')).toEqual([])
	})

	it('covers every registered provider', () => {
		for (const p of KNOWN_PROVIDERS) {
			expect(findMentionedProviders(`use ${p.tokens[0]} for work`)).toContain(p.name)
		}
	})
})

describe('toProseBlock', () => {
	it('returns "Ask the user" prose that lists each check with its fix hint', () => {
		const checks = checkLoop(
			loop({ entryCondition: null, closeCondition: null }),
			ctx({
				steps: [step({ agent: null })],
				connectedProviders: [],
				memberCount: 0,
			}),
		)
		const prose = toProseBlock(checks)
		expect(prose.startsWith('Ask the user:')).toBe(true)
		expect(prose).toMatch(/1\./)
		expect(prose).toContain('update_trigger')
	})

	it('returns an empty string when there is nothing to ask about', () => {
		expect(toProseBlock([])).toBe('')
	})

	it('skips unknown-status checks so a broken check does not surface to the user', () => {
		const prose = toProseBlock([
			{ name: 'has_members', status: 'unknown', message: 'Could not fetch settings' },
		])
		expect(prose).toBe('')
	})
})
