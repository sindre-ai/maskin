import { PostHog } from 'posthog-node'
import { logger } from '../lib/logger'
import type { QuotaErrorCode, QuotaRoute } from './session-quota-context'

/**
 * Maps to the bet's ship-metric vocabulary on `runtime_session_ended`.
 * `irrecoverable` is reserved for the failure modes the bet is explicitly
 * trying to drive to zero — credit exhaustion and runtime timeouts.
 */
export type RuntimeEndReason = 'completed' | 'failed' | 'irrecoverable' | 'user_stopped'

/**
 * Outcome bucket the `agent_session_completed` PostHog event has carried since
 * its 2026-06-09 introduction (see the frontend's `trackAgentSessionCompleted`
 * shape). Kept identical so downstream PostHog dashboards keep matching.
 */
export type AgentSessionOutcome = 'completed' | 'failed' | 'timeout'

export interface RuntimeTelemetryConfig {
	apiKey?: string
	host?: string
	flushAt?: number
	flushInterval?: number
	/** Optional override of the underlying client — used by tests. */
	client?: TelemetryClient
}

/**
 * Narrow interface used by `RuntimeTelemetry`. Lets tests substitute a
 * lightweight stub without faking the full posthog-node surface.
 */
export interface TelemetryClient {
	capture(payload: {
		distinctId: string
		event: string
		properties?: Record<string, unknown>
		groups?: Record<string, string>
	}): void
	shutdown(): Promise<void>
}

interface SessionStartedEvent {
	sessionId: string
	agentServerUrl: string
	sessionStartLatencyMs: number
}

interface SessionEndedEvent {
	sessionId: string
	endReason: RuntimeEndReason
	durationMs: number
	agentServerUrl?: string
}

interface AgentSessionCompletedEvent {
	sessionId: string
	workspaceId: string
	outcome: AgentSessionOutcome
	/**
	 * Quota route inferred from the failure reason via `deriveQuotaContext()`.
	 * Null for successful exits, timeouts without a classified LLM error, or
	 * any lifecycle site that doesn't carry a failure reason (enqueue error,
	 * remote-agent completion signal, reconciler cleanup) — those events still
	 * fire but are naturally excluded from the AC-T3 cohort join.
	 */
	route: QuotaRoute | null
	/**
	 * HTTP-shaped error the AC-T3 PostHog query filters on
	 * (`error_code IN ('HTTP_402','HTTP_429')`). Null for anything else.
	 */
	errorCode: QuotaErrorCode | null
}

interface CrossSessionCheckEvent {
	sessionId: string
	agentServerUrl: string
	hostIsolationOk: boolean
}

interface ConcurrentSessionsGaugeEvent {
	agentServerUrl: string
	concurrentCount: number
}

const DEFAULT_HOST = 'https://eu.i.posthog.com'
const DEFAULT_GAUGE_INTERVAL_MS = 60_000

/**
 * Emits the four ship-metric events for agent session telemetry:
 * - `runtime_session_started`
 * - `runtime_session_ended`
 * - `runtime_concurrent_sessions_gauge`
 * - `runtime_cross_session_check`
 *
 * All `record*` calls are fail-open: any error inside the PostHog client is
 * caught and logged so analytics can never block a session lifecycle. When the
 * API key is unset (local dev, tests) every call becomes a no-op.
 */
export class RuntimeTelemetry {
	private client: TelemetryClient | null
	private gaugeInterval: NodeJS.Timeout | null = null

	constructor(config: RuntimeTelemetryConfig = {}) {
		if (config.client) {
			this.client = config.client
		} else if (config.apiKey) {
			this.client = new PostHog(config.apiKey, {
				host: config.host ?? DEFAULT_HOST,
				flushAt: config.flushAt ?? 20,
				flushInterval: config.flushInterval ?? 10_000,
			})
		} else {
			this.client = null
			logger.info('Runtime telemetry disabled: POSTHOG_API_KEY not set')
		}
	}

	recordSessionStarted({
		sessionId,
		agentServerUrl,
		sessionStartLatencyMs,
	}: SessionStartedEvent): void {
		this.capture({
			distinctId: sessionId,
			event: 'runtime_session_started',
			properties: {
				session_id: sessionId,
				agent_server_url: agentServerUrl,
				session_start_latency_ms: sessionStartLatencyMs,
			},
		})
	}

	recordSessionEnded({
		sessionId,
		endReason,
		durationMs,
		agentServerUrl,
	}: SessionEndedEvent): void {
		this.capture({
			distinctId: sessionId,
			event: 'runtime_session_ended',
			properties: {
				session_id: sessionId,
				end_reason: endReason,
				duration_ms: durationMs,
				...(agentServerUrl ? { agent_server_url: agentServerUrl } : {}),
			},
		})
	}

	/**
	 * Emit `agent_session_completed` server-side with `route` + `error_code`
	 * so the quota-wall-alarm bet's AC-T3 PostHog query can join it against
	 * `quota_alert_fired` on `route` within the 4h pre-window.
	 *
	 * The event was previously fired from the frontend SSE bridge, which had
	 * two gaps that mattered for this bet: (1) sessions that ended while no
	 * browser was watching (triggers, MCP, background reapers) never emitted;
	 * (2) the SSE payload strips `data` for the pg_notify 8KB cap so the
	 * failure route/error_code weren't reachable client-side. Server-side
	 * emission fixes both. The frontend call site is removed in the same
	 * change to avoid double-counting.
	 */
	recordAgentSessionCompleted({
		sessionId,
		workspaceId,
		outcome,
		route,
		errorCode,
	}: AgentSessionCompletedEvent): void {
		this.capture({
			distinctId: sessionId,
			event: 'agent_session_completed',
			properties: {
				entity_id: sessionId,
				entity_type: 'session',
				source: 'system',
				outcome,
				route,
				error_code: errorCode,
				workspace_id: workspaceId,
			},
		})
	}

	recordCrossSessionCheck({
		sessionId,
		agentServerUrl,
		hostIsolationOk,
	}: CrossSessionCheckEvent): void {
		this.capture({
			distinctId: sessionId,
			event: 'runtime_cross_session_check',
			properties: {
				session_id: sessionId,
				agent_server_url: agentServerUrl,
				host_isolation_ok: hostIsolationOk,
			},
		})
	}

	recordConcurrentSessionsGauge({
		agentServerUrl,
		concurrentCount,
	}: ConcurrentSessionsGaugeEvent): void {
		this.capture({
			distinctId: agentServerUrl,
			event: 'runtime_concurrent_sessions_gauge',
			properties: {
				agent_server_url: agentServerUrl,
				concurrent_count: concurrentCount,
			},
		})
	}

	/**
	 * Starts a periodic timer that polls `getConcurrencyByAgentServer` and emits
	 * one `runtime_concurrent_sessions_gauge` event per agent-server bucket.
	 *
	 * The map shape lets the caller iterate every active agent-server even when
	 * its concurrent count is zero — a flat zero is signal, not noise. When the
	 * map is empty the loop emits nothing for that tick.
	 */
	startGaugeLoop(
		getConcurrencyByAgentServer: () => Promise<Map<string, number>>,
		intervalMs: number = DEFAULT_GAUGE_INTERVAL_MS,
	): void {
		// Telemetry disabled (no API key): skip the loop entirely so we don't run
		// the concurrency DB query every interval only to no-op the capture.
		if (!this.client) return
		if (this.gaugeInterval) return
		const tick = async () => {
			try {
				const snapshot = await getConcurrencyByAgentServer()
				for (const [agentServerUrl, concurrentCount] of snapshot) {
					this.recordConcurrentSessionsGauge({ agentServerUrl, concurrentCount })
				}
			} catch (err) {
				logger.warn('Runtime telemetry gauge tick failed', { error: String(err) })
			}
		}
		this.gaugeInterval = setInterval(tick, intervalMs)
		tick().catch(() => {})
	}

	async shutdown(): Promise<void> {
		if (this.gaugeInterval) {
			clearInterval(this.gaugeInterval)
			this.gaugeInterval = null
		}
		if (this.client) {
			try {
				await this.client.shutdown()
			} catch (err) {
				logger.warn('Runtime telemetry shutdown failed', { error: String(err) })
			}
		}
	}

	private capture(payload: {
		distinctId: string
		event: string
		properties?: Record<string, unknown>
	}): void {
		if (!this.client) return
		try {
			this.client.capture({
				...payload,
				properties: {
					...payload.properties,
					// These are backend/system events keyed by session or
					// agent-server id, not by an identified user. Without this flag
					// PostHog creates a Person profile per distinct id — i.e. one per
					// session — which is unbounded growth that inflates MAU-based
					// billing and degrades queries precisely as session count scales,
					// the thing this bet is built to do.
					$process_person_profile: false,
				},
			})
		} catch (err) {
			logger.warn('Runtime telemetry capture failed', {
				event: payload.event,
				error: String(err),
			})
		}
	}
}
