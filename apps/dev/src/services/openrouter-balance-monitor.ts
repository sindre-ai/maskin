import type { Database } from '@maskin/db'
import { findIntegrationRow } from '../lib/integrations/lookup'
import { TokenManager } from '../lib/integrations/oauth/token-manager'
import { slackApiCall } from '../lib/integrations/providers/slack/slack-api'
import { getProvider } from '../lib/integrations/registry'
import { readFallbackConfig } from '../lib/llm-routing'
import { logger } from '../lib/logger'

const TICK_MS = 60 * 60 * 1000 // 1h
const WARN_EVERY_MS = 24 * 60 * 60 * 1000 // 24h
const REQUEST_TIMEOUT_MS = 10_000

/** Warn when the prepaid balance falls under this many US dollars. */
export const LOW_BALANCE_USD = 50

/** #development. */
export const BALANCE_ALERT_SLACK_CHANNEL = 'C06LC37JJCS'

export type BalanceReading = { ok: true; balanceUsd: number } | { ok: false; reason: string }

/**
 * Reads the prepaid balance of the OpenRouter account behind MASKIN_FALLBACK_OPENROUTER_KEY:
 * total_credits minus total_usage, from GET /v1/credits.
 */
export async function readOpenRouterBalance(
	apiKey: string,
	baseUrl: string,
	fetchImpl: typeof fetch = fetch,
): Promise<BalanceReading> {
	try {
		const res = await fetchImpl(`${baseUrl}/v1/credits`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
		if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
		const body = (await res.json()) as { data?: { total_credits?: unknown; total_usage?: unknown } }
		const credits = body.data?.total_credits
		const usage = body.data?.total_usage
		if (typeof credits !== 'number' || typeof usage !== 'number') {
			return { ok: false, reason: 'unexpected response shape' }
		}
		return { ok: true, balanceUsd: credits - usage }
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) }
	}
}

/**
 * Warns the team in Slack before Maskin's OpenRouter balance runs out (it did on 19 Nov 2026
 * and 219 sessions failed for 17 hours before anyone noticed).
 *
 * Ticks hourly. A low balance warns at most once per 24 hours; a failed credits call is
 * reported once and again only after a read has worked in between. The balance is never guessed.
 * The post goes out the way the chargeback DM does: the Slack integration of the ops workspace
 * (MASKIN_OPS_WORKSPACE_ID). Suppression is in memory, so a restart while the balance is still
 * low can warn once more.
 */
export class OpenRouterBalanceMonitor {
	private timer: NodeJS.Timeout | null = null
	private running = false
	private lastWarnedAt = 0
	private failureReported = false

	constructor(
		private db: Database,
		private fetchImpl: typeof fetch = fetch,
	) {}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => this.tick(), TICK_MS)
		setTimeout(() => this.tick(), 60_000).unref()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	async tick(now: Date = new Date()): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			const { apiKey, baseUrl } = readFallbackConfig()
			// No key, or a key for some other provider: there is no OpenRouter balance to watch.
			if (!apiKey || new URL(baseUrl).hostname !== 'openrouter.ai') return

			const reading = await readOpenRouterBalance(apiKey, baseUrl, this.fetchImpl)
			if (!reading.ok) {
				logger.error('OpenRouter balance check failed', { reason: reading.reason })
				if (!this.failureReported) {
					const posted = await this.post(
						`Could not read the OpenRouter balance (${reading.reason}). Chats paid by Maskin could run dry without a warning. Check openrouter.ai/credits.`,
					)
					this.failureReported = posted
				}
				return
			}
			this.failureReported = false
			if (reading.balanceUsd >= LOW_BALANCE_USD) return
			if (now.getTime() - this.lastWarnedAt < WARN_EVERY_MS) return

			const posted = await this.post(
				`OpenRouter balance is $${reading.balanceUsd.toFixed(2)}, under $${LOW_BALANCE_USD}. Chats paid by Maskin stop when it hits zero. Top up at openrouter.ai/credits.`,
			)
			if (posted) this.lastWarnedAt = now.getTime()
		} catch (err) {
			logger.error('OpenRouter balance monitor tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}

	/** True when Slack took the message. Never throws, so a Slack outage cannot break the tick. */
	private async post(text: string): Promise<boolean> {
		try {
			const opsWorkspaceId = process.env.MASKIN_OPS_WORKSPACE_ID?.trim()
			if (!opsWorkspaceId) {
				logger.error('OpenRouter balance alert dropped: MASKIN_OPS_WORKSPACE_ID unset', { text })
				return false
			}
			const integration = await findIntegrationRow(this.db, opsWorkspaceId, 'slack', null, {})
			if (!integration) {
				logger.error(
					'OpenRouter balance alert dropped: no active slack integration in ops workspace',
					{
						opsWorkspaceId,
						text,
					},
				)
				return false
			}
			const token = await new TokenManager().getValidToken(
				this.db,
				integration.id,
				getProvider('slack'),
			)
			await slackApiCall(token, 'chat.postMessage', {
				channel: BALANCE_ALERT_SLACK_CHANNEL,
				text,
				unfurl_links: false,
			})
			return true
		} catch (err) {
			logger.error('OpenRouter balance alert failed to post', {
				error: err instanceof Error ? err.message : String(err),
				text,
			})
			return false
		}
	}
}
