import { isWithinActiveHours, parseActiveHours } from './active-hours'
import { buildGhDispatchBody, buildSlackMessage, postGhDispatch, postSlack } from './alerts'
import { type SilenceStateKV, clearSilence, raiseSilence, readSilenceState } from './dedup'
import { fetchHeartbeat } from './heartbeat'
import { evaluateSilence } from './silence'

export interface Env {
	// Secrets — provisioned via `wrangler secret put <NAME>`. Never checked in.
	HEARTBEAT_URL: string
	HEARTBEAT_SHARED_SECRET: string
	SLACK_WEBHOOK_URL: string
	GH_DISPATCH_TOKEN: string
	// Vars — safe defaults in wrangler.toml, overridable per environment.
	SILENCE_THRESHOLD_MIN: string
	ACTIVE_HOURS: string
	ACTIVE_TIMEZONE: string
	GH_DISPATCH_REPO: string
	BET_URL: string
	// KV binding for silence-flag dedup.
	SILENCE_STATE: KVNamespace
}

export type TickDeps = {
	fetchImpl?: typeof fetch
	now?: () => Date
	logger?: Pick<Console, 'log' | 'warn' | 'error'>
}

export type TickResult = {
	silent: boolean
	inActiveWindow: boolean
	paged: boolean
	slack?: { ok: boolean; status: number }
	dispatch?: { ok: boolean; status: number }
	reason?: string
}

/**
 * Evaluate one cron tick. Extracted so tests can drive it without spinning up
 * the Workers runtime. The `scheduled` export is a thin wrapper around this.
 */
export async function runTick(env: Env, deps: TickDeps = {}): Promise<TickResult> {
	const fetchImpl = deps.fetchImpl ?? fetch
	const now = deps.now ? deps.now() : new Date()
	const logger = deps.logger ?? console

	const thresholdRaw = Number(env.SILENCE_THRESHOLD_MIN)
	const threshold = Number.isFinite(thresholdRaw) && thresholdRaw >= 0 ? thresholdRaw : 8
	const window = parseActiveHours(
		env.ACTIVE_HOURS ?? '07:00-23:00',
		env.ACTIVE_TIMEZONE ?? 'Europe/Copenhagen',
	)

	const hb = await fetchHeartbeat(env.HEARTBEAT_URL, env.HEARTBEAT_SHARED_SECRET, fetchImpl)
	const verdict = evaluateSilence(hb, threshold)
	const inActiveWindow = isWithinActiveHours(now, window)
	const kv = env.SILENCE_STATE as SilenceStateKV

	if (!verdict.silent) {
		// A clean heartbeat clears the silence flag regardless of the window —
		// otherwise a recovery outside 07:00–23:00 would leave the flag set and
		// the next in-window outage would be suppressed as a duplicate.
		const state = await readSilenceState(kv)
		if (state.kind === 'active') {
			await clearSilence(kv)
			logger.log('liveness-worker: silence cleared')
		}
		return { silent: false, inActiveWindow, paged: false }
	}

	// Silent. Only page during active hours. Outside the window we deliberately
	// do NOT touch the flag: an off-hours outage remains "silent" state that
	// the first in-window tick will act on, dedup notwithstanding.
	if (!inActiveWindow) {
		logger.log(`liveness-worker: silent outside active hours (reason=${verdict.reason})`)
		return { silent: true, inActiveWindow: false, paged: false, reason: verdict.reason }
	}

	const state = await readSilenceState(kv)
	if (state.kind === 'active') {
		logger.log(`liveness-worker: silence already flagged since ${state.sinceIso} — skipping page`)
		return { silent: true, inActiveWindow: true, paged: false, reason: verdict.reason }
	}

	// First silence tick inside the active window — raise the flag before the
	// alert fires so a concurrent tick can't double-page.
	await raiseSilence(kv, now)

	const ctx = { detectedAt: now, verdict }
	const slackMsg = buildSlackMessage(ctx, env.BET_URL)
	const dispatchBody = buildGhDispatchBody(ctx)

	const [slack, dispatch] = await Promise.all([
		postSlack(env.SLACK_WEBHOOK_URL, slackMsg, fetchImpl).catch((err) => {
			logger.error(`liveness-worker: slack post failed: ${err}`)
			return { ok: false, status: 0 }
		}),
		postGhDispatch(env.GH_DISPATCH_REPO, env.GH_DISPATCH_TOKEN, dispatchBody, fetchImpl).catch(
			(err) => {
				logger.error(`liveness-worker: gh dispatch failed: ${err}`)
				return { ok: false, status: 0 }
			},
		),
	])

	if (!slack.ok) logger.warn(`liveness-worker: slack non-ok status=${slack.status}`)
	if (!dispatch.ok) logger.warn(`liveness-worker: gh dispatch non-ok status=${dispatch.status}`)

	return {
		silent: true,
		inActiveWindow: true,
		paged: true,
		slack,
		dispatch,
		reason: verdict.reason,
	}
}

export default {
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(runTick(env).then(() => undefined))
	},
}
