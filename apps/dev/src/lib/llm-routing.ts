import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import { and, eq, gte, sql } from 'drizzle-orm'
import { getValidOAuthToken } from './claude-oauth'
import type { WorkspaceSettings } from './types'

/**
 * Tag persisted on `sessions.config.llm_route` so we can later attribute usage
 * (and enforce per-actor quotas) for sessions that ran on the system fallback.
 */
export const LLM_ROUTE_SYSTEM_FALLBACK = 'system_fallback'
export const LLM_ROUTE_CUSTOM = 'workspace_custom'
export const LLM_ROUTE_OAUTH = 'claude_oauth'
export const LLM_ROUTE_API_KEY = 'workspace_api_key'
export const LLM_ROUTE_AGENT = 'agent_api_key'

export type LlmRoute =
	| typeof LLM_ROUTE_SYSTEM_FALLBACK
	| typeof LLM_ROUTE_CUSTOM
	| typeof LLM_ROUTE_OAUTH
	| typeof LLM_ROUTE_API_KEY
	| typeof LLM_ROUTE_AGENT

export interface LlmRoutingResult {
	route: LlmRoute
	/** Env vars to merge into the container environment. */
	envVars: Record<string, string>
}

export interface FallbackConfig {
	apiKey?: string
	baseUrl?: string
	model?: string
	smallModel?: string
	dailyTokenLimit: number
}

export interface AgentLlmConfig {
	provider?: string | null
	apiKey?: string | null
}

/**
 * Reads MASKIN_FALLBACK_* env vars once. The fallback is only "available" when
 * the operator has set MASKIN_FALLBACK_OPENROUTER_KEY — otherwise we skip the
 * fallback path and let the session fail with a clearer "no credentials" error
 * upstream.
 */
export function readFallbackConfig(env: NodeJS.ProcessEnv = process.env): FallbackConfig {
	const rawLimit = Number(env.MASKIN_FALLBACK_DAILY_TOKEN_LIMIT)
	const dailyTokenLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 550_000
	return {
		apiKey: env.MASKIN_FALLBACK_OPENROUTER_KEY?.trim() || undefined,
		baseUrl: env.MASKIN_FALLBACK_BASE_URL?.trim() || 'https://openrouter.ai/api',
		model: env.MASKIN_FALLBACK_MODEL?.trim() || 'deepseek/deepseek-v4-flash',
		smallModel:
			env.MASKIN_FALLBACK_SMALL_MODEL?.trim() ||
			env.MASKIN_FALLBACK_MODEL?.trim() ||
			'deepseek/deepseek-v4-flash',
		dailyTokenLimit,
	}
}

/**
 * Sums input+output tokens across the actor's last-24h sessions that ran on
 * the system fallback route. Used to enforce MASKIN_FALLBACK_DAILY_TOKEN_LIMIT.
 *
 * `null` means "we couldn't measure" — caller should treat conservatively.
 */
export async function getActorFallbackTokenUsage24h(
	db: Database,
	actorId: string,
): Promise<number> {
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
	const rows = await db
		.select({
			inputTokens: sessions.inputTokens,
			outputTokens: sessions.outputTokens,
		})
		.from(sessions)
		.where(
			and(
				eq(sessions.actorId, actorId),
				gte(sessions.createdAt, since),
				sql`${sessions.config}->>'llm_route' = ${LLM_ROUTE_SYSTEM_FALLBACK}`,
			),
		)

	let total = 0
	for (const row of rows) {
		total += row.inputTokens ?? 0
		total += row.outputTokens ?? 0
	}
	return total
}

export class FallbackQuotaExceededError extends Error {
	constructor(
		readonly used: number,
		readonly limit: number,
	) {
		super(
			`Free fallback quota exceeded: ${used.toLocaleString()} of ${limit.toLocaleString()} tokens used in the last 24 hours. Add a Claude subscription, an Anthropic API key, or a custom model endpoint in workspace settings → keys.`,
		)
		this.name = 'FallbackQuotaExceededError'
	}
}

/**
 * Validates a workspace's custom_llm config. Returns the env vars to inject,
 * or null if the config is incomplete (which the caller treats as "skip,
 * fall through to the next route").
 *
 * Required: enabled=true + base_url + api_key + model. small_fast_model is
 * optional and falls back to model.
 */
function buildCustomLlmEnv(custom: WorkspaceSettings['custom_llm']): Record<string, string> | null {
	if (!custom?.enabled) return null
	const baseUrl = custom.base_url?.trim()
	const apiKey = custom.api_key?.trim()
	const model = custom.model?.trim()
	if (!baseUrl || !apiKey || !model) return null
	const smallModel = custom.small_fast_model?.trim() || model
	return {
		ANTHROPIC_BASE_URL: baseUrl,
		ANTHROPIC_AUTH_TOKEN: apiKey,
		// Force-clear ANTHROPIC_API_KEY so Claude Code uses ANTHROPIC_AUTH_TOKEN's
		// bearer-token path instead of x-api-key (Morph guide caveat).
		ANTHROPIC_API_KEY: '',
		ANTHROPIC_MODEL: model,
		ANTHROPIC_SMALL_FAST_MODEL: smallModel,
	}
}

/**
 * Resolves which LLM the session should use, in priority order:
 *
 *   1. Agent-level api_key (caller-injected override)
 *   2. Workspace custom_llm (BYO endpoint — OpenRouter, Ollama, vLLM, …)
 *   3. Workspace Claude OAuth (Pro/Max/Teams subscription)
 *   4. Workspace anthropic api_key (`settings.llm_keys.anthropic`)
 *   5. System fallback (MASKIN_FALLBACK_OPENROUTER_KEY) with daily quota
 *
 * Throws FallbackQuotaExceededError if route #5 is selected and the actor has
 * already burned through their 24h budget.
 *
 * Returns null if the agent uses a non-anthropic provider (e.g. OpenAI native);
 * caller continues to handle OPENAI_API_KEY injection itself.
 */
export async function resolveLlmRoute(params: {
	db: Database
	workspaceId: string
	actorId: string
	wsSettings: WorkspaceSettings
	agent: AgentLlmConfig
}): Promise<LlmRoutingResult | null> {
	const { db, workspaceId, actorId, wsSettings, agent } = params

	// 1. Agent-level override — only handled here for anthropic; non-anthropic
	//    providers fall through to caller (matches existing behavior).
	if (agent.apiKey) {
		if (agent.provider === 'anthropic') {
			return {
				route: LLM_ROUTE_AGENT,
				envVars: { ANTHROPIC_API_KEY: agent.apiKey },
			}
		}
		// caller (session-manager) handles OPENAI_API_KEY etc.
		return null
	}

	// 2. Workspace custom_llm
	const customEnv = buildCustomLlmEnv(wsSettings.custom_llm)
	if (customEnv) {
		return { route: LLM_ROUTE_CUSTOM, envVars: customEnv }
	}

	// 3. Claude OAuth subscription
	try {
		const oauthResult = await getValidOAuthToken(db, workspaceId)
		if (oauthResult) {
			const envVars: Record<string, string> = {
				CLAUDE_OAUTH_ACCESS_TOKEN: oauthResult.tokens.accessToken,
				CLAUDE_OAUTH_REFRESH_TOKEN: oauthResult.tokens.refreshToken,
				CLAUDE_OAUTH_EXPIRES_AT: String(oauthResult.tokens.expiresAt),
			}
			if (oauthResult.tokens.scopes) {
				envVars.CLAUDE_OAUTH_SCOPES = JSON.stringify(oauthResult.tokens.scopes)
			}
			if (oauthResult.tokens.subscriptionType) {
				envVars.CLAUDE_OAUTH_SUBSCRIPTION_TYPE = oauthResult.tokens.subscriptionType
			}
			return { route: LLM_ROUTE_OAUTH, envVars }
		}
	} catch {
		// Swallow OAuth errors and let the next route take over — the warning
		// is logged by the caller for parity with the previous behavior.
	}

	// 4. Workspace anthropic api key
	const wsAnthropic = wsSettings.llm_keys?.anthropic
	if (wsAnthropic) {
		return {
			route: LLM_ROUTE_API_KEY,
			envVars: { ANTHROPIC_API_KEY: wsAnthropic },
		}
	}

	// 5. System fallback
	const fallback = readFallbackConfig()
	if (!fallback.apiKey) return null
	const used = await getActorFallbackTokenUsage24h(db, actorId)
	if (used >= fallback.dailyTokenLimit) {
		throw new FallbackQuotaExceededError(used, fallback.dailyTokenLimit)
	}
	return {
		route: LLM_ROUTE_SYSTEM_FALLBACK,
		envVars: {
			ANTHROPIC_BASE_URL: fallback.baseUrl ?? 'https://openrouter.ai/api',
			ANTHROPIC_AUTH_TOKEN: fallback.apiKey,
			ANTHROPIC_API_KEY: '',
			ANTHROPIC_MODEL: fallback.model ?? 'deepseek/deepseek-v4-flash',
			ANTHROPIC_SMALL_FAST_MODEL: fallback.smallModel ?? fallback.model ?? 'deepseek/deepseek-v4-flash',
		},
	}
}
