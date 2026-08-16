import { sortByPriority } from './priority'
import type { BetCheckContext, BetInput, SetupCheck } from './types'

function safeCheck(name: string, run: () => SetupCheck | null): SetupCheck | null {
	try {
		return run()
	} catch (err) {
		console.error(`[setup-guidance] bet check '${name}' threw, degrading to unknown:`, err)
		return {
			name,
			status: 'unknown',
			message: `Could not evaluate ${name}: ${err instanceof Error ? err.message : String(err)}`,
		}
	}
}

function agentsRunnable(ctx: BetCheckContext): SetupCheck | null {
	if (ctx.workspace.hasLlmKey || ctx.workspace.hasClaudeOAuth) return null
	return {
		name: 'agents_runnable',
		status: 'warn',
		message:
			'No LLM credentials on this workspace — any agent asked to work on this object will fail to start a session.',
		fix: {
			tool: 'set_llm_api_key',
			args_hint: 'anthropic or openai key, or import a Claude Pro/Max subscription',
			why: 'Sessions read workspace-level llm_keys or claude_oauth to authenticate the model call.',
		},
	}
}

function elevatedStatus(bet: BetInput, ctx: BetCheckContext): SetupCheck | null {
	const order = ctx.statusOrder ?? []
	if (order.length === 0 || !bet.status) return null
	const lowest = order[0]
	if (bet.status === lowest) return null
	if (!order.includes(bet.status)) return null
	return {
		name: 'elevated_status',
		status: 'warn',
		message: `Status "${bet.status}" is above the entry status "${lowest}" for ${bet.type}s in this workspace — usually earned, not set at creation.`,
		fix: {
			tool: 'update_objects',
			args_hint: `set status: "${lowest}" (or leave off — create_objects defaults to the lowest configured status)`,
			why: 'Elevated statuses skip the earlier stages of review, discovery, or qualification.',
		},
	}
}

export function checkBet(bet: BetInput, ctx: BetCheckContext): SetupCheck[] {
	const results: (SetupCheck | null)[] = [
		safeCheck('agents_runnable', () => agentsRunnable(ctx)),
		safeCheck('elevated_status', () => elevatedStatus(bet, ctx)),
	]
	return sortByPriority(results.filter((c): c is SetupCheck => c !== null))
}
