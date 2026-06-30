#!/usr/bin/env node

/**
 * Slack notification module for the quota poller.
 *
 * Sends Slack alerts via Incoming Webhook when quotas exceed the configured
 * threshold, and recovery messages when a previously-exceeded route drops
 * back below threshold. Persists poll state to a JSON file between runs so
 * recovery detection works across cron cycles.
 *
 * Environment:
 *   SLACK_QUOTA_WEBHOOK_URL  (required)  Slack Incoming Webhook URL
 *   POLLER_STATE_FILE        (optional)  Path to state file  [default: /tmp/quota-poller-state.json]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { env } from 'node:process'
import type { PollResult } from './poller'

/* -------------------------------------------------------------------------- */
/*  Logger (mirrors poller.ts inline logger)                                  */
/* -------------------------------------------------------------------------- */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

function log(level: LogLevel, msg: string, context?: Record<string, unknown>) {
	const entry = { level, msg, timestamp: new Date().toISOString(), module: 'notifier', ...context }
	const output = JSON.stringify(entry)
	if (level === 'error') {
		console.error(output)
	} else {
		console.log(output)
	}
}

const logger = {
	debug: (msg: string, ctx?: Record<string, unknown>) => log('debug', msg, ctx),
	info: (msg: string, ctx?: Record<string, unknown>) => log('info', msg, ctx),
	warn: (msg: string, ctx?: Record<string, unknown>) => log('warn', msg, ctx),
	error: (msg: string, ctx?: Record<string, unknown>) => log('error', msg, ctx),
}

/* -------------------------------------------------------------------------- */
/*  Config                                                                    */
/* -------------------------------------------------------------------------- */

const WEBHOOK_URL = env.SLACK_QUOTA_WEBHOOK_URL
const STATE_FILE_PATH = env.POLLER_STATE_FILE || '/tmp/quota-poller-state.json'

/* -------------------------------------------------------------------------- */
/*  State persistence                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Read the previous poll result from the state file.
 * Returns null on first run or if the file is missing/corrupted.
 */
export function readPreviousState(): PollResult | null {
	if (!existsSync(STATE_FILE_PATH)) return null
	try {
		const raw = readFileSync(STATE_FILE_PATH, 'utf-8')
		return JSON.parse(raw) as PollResult
	} catch (err) {
		logger.warn('Failed to read previous poller state', { error: String(err) })
		return null
	}
}

/**
 * Persist the current poll result for comparison on the next run.
 */
export function writeState(result: PollResult): void {
	try {
		writeFileSync(STATE_FILE_PATH, JSON.stringify(result), 'utf-8')
		logger.debug('Wrote poller state', { path: STATE_FILE_PATH })
	} catch (err) {
		logger.error('Failed to write poller state', { error: String(err), path: STATE_FILE_PATH })
	}
}

/* -------------------------------------------------------------------------- */
/*  Slack message formatting                                                  */
/* -------------------------------------------------------------------------- */

interface SlackBlock {
	[key: string]: unknown
}

function buildAlertBlocks(
	route: string,
	headroomPct: number,
	threshold: number,
	used: number,
	limit: number,
): SlackBlock[] {
	return [
		{
			type: 'header',
			text: { type: 'plain_text', text: `🚨 Quota alert: ${route}`, emoji: true },
		},
		{
			type: 'section',
			fields: [
				{ type: 'mrkdwn', text: `*Route:* \`${route}\`` },
				{ type: 'mrkdwn', text: `*Usage:* ${headroomPct}%` },
				{ type: 'mrkdwn', text: `*Threshold:* ${threshold}%` },
				{ type: 'mrkdwn', text: `*Consumed:* ${used} / ${limit}` },
			],
		},
	]
}

function buildRecoveryBlocks(route: string, headroomPct: number, threshold: number): SlackBlock[] {
	return [
		{
			type: 'section',
			text: {
				type: 'mrkdwn',
				text: `✅ *Recovered:* \`${route}\` back to ${headroomPct}% — below ${threshold}% threshold`,
			},
		},
	]
}

/* -------------------------------------------------------------------------- */
/*  Slack webhook client                                                      */
/* -------------------------------------------------------------------------- */

async function postToSlack(message: { blocks: SlackBlock[] }): Promise<void> {
	if (!WEBHOOK_URL) {
		logger.warn('SLACK_QUOTA_WEBHOOK_URL not set — skipping Slack notification')
		return
	}

	try {
		const res = await fetch(WEBHOOK_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(message),
		})
		if (!res.ok) {
			const body = await res.text().catch(() => '')
			logger.error('Slack webhook returned non-OK status', {
				status: res.status,
				body: body.slice(0, 200),
			})
		}
	} catch (err) {
		logger.error('Slack webhook request failed', { error: String(err) })
	}
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Compare the current poll result against the previous state and send
 * Slack notifications:
 *   - Alert per route currently exceeding the threshold
 *   - Recovery per route that was exceeding and is now below threshold
 *
 * Persists the current state for the next run.
 */
export async function sendAlerts(result: PollResult): Promise<void> {
	const previous = readPreviousState()

	const quotaEntries = Object.entries(result.quotas)

	// Send alerts for routes currently above threshold
	for (const [route, entry] of quotaEntries) {
		if (!entry.exceeded) continue
		const blocks = buildAlertBlocks(
			route,
			entry.headroom_pct,
			result.threshold_pct,
			entry.used,
			entry.limit,
		)
		await postToSlack({ blocks })
		logger.info('Sent Slack alert', { route, headroom_pct: entry.headroom_pct })
	}

	// Send recovery messages for routes that were above threshold and are now below.
	// Defensive access on `previous.quotas` — a state file written by an older schema
	// (where `quotas` was named differently or missing) would otherwise crash the poll.
	if (previous) {
		for (const [route, entry] of quotaEntries) {
			const prevEntry = previous.quotas?.[route]
			if (!prevEntry?.exceeded || entry.exceeded) continue
			const blocks = buildRecoveryBlocks(route, entry.headroom_pct, result.threshold_pct)
			await postToSlack({ blocks })
			logger.info('Sent Slack recovery', { route, headroom_pct: entry.headroom_pct })
		}
	}

	// Persist state for the next poll cycle
	writeState(result)
}
