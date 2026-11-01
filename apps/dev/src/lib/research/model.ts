import {
	type ChatCredentials,
	LLM_ROUTE_API_KEY,
	LLM_ROUTE_CUSTOM,
	LLM_ROUTE_MASKIN_PLAN,
} from '../llm-routing'
import { type ModelPricing, getModelPricing } from '../openrouter-pricing'
import type { WorkspaceSettings } from '../types'

/**
 * The price table is OpenRouter's catalogue, which names Anthropic models
 * "anthropic/claude-haiku-4.5" where the Anthropic API says
 * "claude-haiku-4-5-20251001". Tries the model id as given, then that spelling.
 * Null means the model has no price, and a run on it refuses to start.
 */
export async function lookupResearchModelPricing(
	model: string,
	provider: ChatCredentials['provider'],
): Promise<ModelPricing | null> {
	const candidates = [model]
	if (provider === 'anthropic') {
		const dotted = model.replace(/-\d{8}$/, '').replace(/-(\d+)-(\d+)$/, '-$1.$2')
		candidates.push(`anthropic/${model}`, `anthropic/${dotted}`)
	}
	for (const id of candidates) {
		const pricing = await getModelPricing(id)
		if (pricing) return pricing
	}
	return null
}

/**
 * Which route the credentials came from, in the vocabulary sessions use for
 * llm_route. Mirrors the order resolveChatCredentials tries them in, and decides
 * whether the run counts toward the plan cap (only maskin_plan does).
 */
export function researchRouteOf(
	credentials: ChatCredentials,
	wsSettings: WorkspaceSettings,
): string {
	if (wsSettings.custom_llm?.enabled && credentials.baseUrl) return LLM_ROUTE_CUSTOM
	if (credentials.provider === 'anthropic') return LLM_ROUTE_API_KEY
	return LLM_ROUTE_MASKIN_PLAN
}
