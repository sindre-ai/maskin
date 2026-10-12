import { isEnterprise } from './enterprise'
import { isMaskinPlanRouted, readFallbackConfig } from './llm-routing'
import type { WorkspaceSettings } from './types'

/**
 * Credentials and model choices for one live (voice) call.
 *
 * Live mode runs on OpenRouter only. It never uses Claude OAuth, because that
 * token is not a portable bearer outside the Claude CLI, and never the
 * workspace's Anthropic key, because the streamed turn, the TTS and the STT all
 * go through OpenRouter's OpenAI-compatible API.
 */
export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1'

export type LiveRoute = 'workspace_openrouter_key' | 'workspace_custom_llm' | 'maskin_plan'

export interface LiveCredentials {
	apiKey: string
	baseUrl: string
	route: LiveRoute
	llmModel: string
	ttsModel: string
	ttsVoice: string
	sttModel: string
	/** OpenRouter provider preferences, set only on the Maskin-funded route. */
	providerPrefs?: { zdr: true }
}

export const DEFAULT_LIVE_TTS_MODEL = 'openai/gpt-4o-mini-tts-2025-12-15'
export const DEFAULT_LIVE_TTS_VOICE = 'alloy'
export const DEFAULT_LIVE_STT_MODEL = 'openai/gpt-4o-mini-transcribe'

/** `vendor/model` or `vendor/model:variant`, the shape OpenRouter routes on. */
const OPENROUTER_MODEL_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._:-]*$/i

export function isOpenRouterModelId(id: string | null | undefined): id is string {
	return typeof id === 'string' && OPENROUTER_MODEL_ID.test(id.trim())
}

function isOpenRouterHost(baseUrl: string | null | undefined): boolean {
	if (!baseUrl) return false
	try {
		const host = new URL(baseUrl).hostname.toLowerCase()
		return host === 'openrouter.ai' || host.endsWith('.openrouter.ai')
	} catch {
		return false
	}
}

export interface ResolveLiveCredentialsParams {
	wsSettings: WorkspaceSettings
	workspace: { enterpriseGranted: boolean | null; billingOwnerId: string | null }
	agent: {
		llmConfig?: { model?: string | null } | null
		metadata?: Record<string, unknown> | null
	}
	env?: NodeJS.ProcessEnv
}

function agentVoice(metadata: Record<string, unknown> | null | undefined): string | null {
	const live = metadata?.live
	if (live && typeof live === 'object' && 'voice' in live) {
		const voice = (live as { voice?: unknown }).voice
		if (typeof voice === 'string' && voice.trim()) return voice.trim()
	}
	return null
}

/**
 * Ladder: workspace OpenRouter key, then a custom_llm pointed at OpenRouter,
 * then Maskin's operator key for plans Maskin funds. Returns null when none
 * applies, which the route turns into a 409 "no live-capable credentials".
 */
export function resolveLiveCredentials(p: ResolveLiveCredentialsParams): LiveCredentials | null {
	const env = p.env ?? process.env
	const fallback = readFallbackConfig(env)

	let apiKey: string | undefined
	let route: LiveRoute | undefined
	let providerPrefs: LiveCredentials['providerPrefs']

	const wsKey = p.wsSettings.llm_keys?.openrouter?.trim()
	const custom = p.wsSettings.custom_llm
	if (wsKey) {
		apiKey = wsKey
		route = 'workspace_openrouter_key'
	} else if (custom?.enabled && custom.api_key?.trim() && isOpenRouterHost(custom.base_url)) {
		apiKey = custom.api_key.trim()
		route = 'workspace_custom_llm'
	} else if (
		isMaskinPlanRouted(p.wsSettings.billing) &&
		!isEnterprise(p.workspace, env) &&
		fallback.apiKey
	) {
		apiKey = fallback.apiKey
		route = 'maskin_plan'
		if (fallback.zdr) providerPrefs = { zdr: true }
	}
	if (!apiKey || !route) return null

	const agentModel = p.agent.llmConfig?.model?.trim()
	const llmModel =
		(isOpenRouterModelId(agentModel) ? agentModel : undefined) ||
		(isOpenRouterModelId(env.MASKIN_LIVE_MODEL) ? env.MASKIN_LIVE_MODEL.trim() : undefined) ||
		fallback.model ||
		'deepseek/deepseek-v4.1-flash'

	return {
		apiKey,
		baseUrl: OPENROUTER_API_BASE,
		route,
		llmModel,
		ttsModel: env.MASKIN_LIVE_TTS_MODEL?.trim() || DEFAULT_LIVE_TTS_MODEL,
		ttsVoice:
			agentVoice(p.agent.metadata) || env.MASKIN_LIVE_TTS_VOICE?.trim() || DEFAULT_LIVE_TTS_VOICE,
		sttModel: env.MASKIN_LIVE_STT_MODEL?.trim() || DEFAULT_LIVE_STT_MODEL,
		...(providerPrefs && { providerPrefs }),
	}
}
