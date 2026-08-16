import { sortByPriority } from './priority'
import type { ActorCheckContext, ActorInput, SetupCheck } from './types'

function safeCheck(name: string, run: () => SetupCheck | null): SetupCheck | null {
	try {
		return run()
	} catch (err) {
		console.error(`[setup-guidance] actor check '${name}' threw, degrading to unknown:`, err)
		return {
			name,
			status: 'unknown',
			message: `Could not evaluate ${name}: ${err instanceof Error ? err.message : String(err)}`,
		}
	}
}

function agentsRunnable(ctx: ActorCheckContext): SetupCheck | null {
	if (ctx.workspace.hasLlmKey || ctx.workspace.hasClaudeOAuth) return null
	return {
		name: 'agents_runnable',
		status: 'warn',
		message:
			'No LLM credentials on this workspace — this actor cannot run a session until credentials are added.',
		fix: {
			tool: 'set_llm_api_key',
			args_hint: 'anthropic or openai key, or import a Claude Pro/Max subscription',
			why: 'Sessions read workspace-level llm_keys or claude_oauth — there is no per-agent credential field.',
		},
	}
}

export function checkActor(_actor: ActorInput, ctx: ActorCheckContext): SetupCheck[] {
	const results: (SetupCheck | null)[] = [safeCheck('agents_runnable', () => agentsRunnable(ctx))]
	return sortByPriority(results.filter((c): c is SetupCheck => c !== null))
}
