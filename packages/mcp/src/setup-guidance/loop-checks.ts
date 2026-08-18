import { sortByPriority } from './priority'
import { findMentionedProviders } from './providers'
import type { LoopCheckContext, LoopInput, SetupCheck } from './types'

/**
 * Wrap a check body so any thrown error becomes a `status: 'unknown'` entry
 * rather than failing the whole run. Never rethrows.
 */
function safeCheck(name: string, run: () => SetupCheck | null): SetupCheck | null {
	try {
		return run()
	} catch (err) {
		console.error(`[setup-guidance] loop check '${name}' threw, degrading to unknown:`, err)
		return {
			name,
			status: 'unknown',
			message: `Could not evaluate ${name}: ${err instanceof Error ? err.message : String(err)}`,
		}
	}
}

function stepsHaveAgents(ctx: LoopCheckContext): SetupCheck | null {
	if (ctx.steps.length === 0) {
		return {
			name: 'steps_have_agents',
			status: 'fail',
			message: 'This loop has no steps yet — add a trigger with a target agent so it can run.',
			fix: {
				tool: 'create_trigger',
				args_hint: 'target_actor_id + action_prompt + a cron/event/reminder config',
				why: 'A loop with no triggers cannot fire — nothing will ever process items in it.',
			},
		}
	}
	const missing = ctx.steps.filter((s) => s.agent === null)
	if (missing.length === 0) return null
	return {
		name: 'steps_have_agents',
		status: 'fail',
		message: `${missing.length} of ${ctx.steps.length} step${ctx.steps.length === 1 ? '' : 's'} has no agent assigned.`,
		fix: {
			tool: 'update_trigger',
			args_hint: `set target_actor_id on trigger${missing.length === 1 ? '' : 's'}: ${missing.map((s) => s.triggerId).join(', ')}`,
			why: 'A step without a target agent will never dispatch a session when the trigger fires.',
		},
	}
}

function agentsRunnable(ctx: LoopCheckContext): SetupCheck | null {
	if (ctx.workspace.hasLlmKey || ctx.workspace.hasClaudeOAuth) return null
	return {
		name: 'agents_runnable',
		status: 'warn',
		message:
			'No LLM credentials on this workspace — agents can be assigned but their sessions will fail to start.',
		fix: {
			tool: 'set_llm_api_key',
			args_hint: 'anthropic or openai key, or import a Claude Pro/Max subscription',
			why: 'Sessions read workspace-level llm_keys or claude_oauth to authenticate the model call.',
		},
	}
}

function connectorsConnected(ctx: LoopCheckContext): SetupCheck | null {
	const connected = new Set(ctx.connectedProviders.map((p) => p.toLowerCase()))
	const missing = new Set<string>()
	for (const step of ctx.steps) {
		const blobs: string[] = []
		if (step.agent?.description) blobs.push(step.agent.description)
		if (step.triggerActionPrompt) blobs.push(step.triggerActionPrompt)
		if (step.triggerConfig !== undefined && step.triggerConfig !== null) {
			try {
				blobs.push(JSON.stringify(step.triggerConfig))
			} catch {
				// Circular / unserialisable config — skip, don't fail the check.
			}
		}
		for (const blob of blobs) {
			for (const provider of findMentionedProviders(blob)) {
				if (!connected.has(provider.toLowerCase())) missing.add(provider)
			}
		}
	}
	if (missing.size === 0) return null
	const list = Array.from(missing)
	const first = list[0]
	return {
		name: 'connectors_connected',
		status: 'warn',
		message: `Prompts or configs reference ${list.join(', ')}, but ${list.length === 1 ? 'that provider is' : 'those providers are'} not connected in this workspace.`,
		fix: {
			tool: 'connect_integration',
			args_hint: `provider: ${first}${list.length > 1 ? ` (also: ${list.slice(1).join(', ')})` : ''}`,
			why: 'Agents referencing a provider will fail (or silently no-op) if the integration is not connected.',
		},
	}
}

function hasMembers(ctx: LoopCheckContext): SetupCheck | null {
	if (ctx.memberCount > 0) return null
	return {
		name: 'has_members',
		status: 'warn',
		message: 'No objects are linked into this loop yet — nothing for the agents to process.',
		fix: {
			tool: 'create_objects',
			args_hint: 'add insight/bet/task objects and link them with in_loop relationships',
			why: 'A loop only does work on objects reachable via in_loop edges.',
		},
	}
}

function conditionsSet(loop: LoopInput): SetupCheck | null {
	const entry = loop.entryCondition?.trim()
	const close = loop.closeCondition?.trim()
	if (entry && close) return null
	const missing: string[] = []
	if (!entry) missing.push('entryCondition')
	if (!close) missing.push('closeCondition')
	return {
		name: 'conditions_set',
		status: 'warn',
		message: `Loop is missing ${missing.join(' and ')} — the intent of the loop is not written down.`,
		fix: {
			tool: 'update_objects',
			args_hint: 'set metadata.entry_condition and metadata.close_condition on the loop object',
			why: 'Without conditions the agents cannot judge what belongs in the loop or when to close an item.',
		},
	}
}

export function checkLoop(loop: LoopInput, ctx: LoopCheckContext): SetupCheck[] {
	const results: (SetupCheck | null)[] = [
		safeCheck('steps_have_agents', () => stepsHaveAgents(ctx)),
		safeCheck('agents_runnable', () => agentsRunnable(ctx)),
		safeCheck('connectors_connected', () => connectorsConnected(ctx)),
		safeCheck('has_members', () => hasMembers(ctx)),
		safeCheck('conditions_set', () => conditionsSet(loop)),
	]
	return sortByPriority(results.filter((c): c is SetupCheck => c !== null))
}
