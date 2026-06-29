#!/usr/bin/env node

/**
 * Quota poller — standalone Node.js script that hits both LLM provider quota
 * endpoints and emits structured quota data.
 *
 * Three quotas:
 *   claude_weekly     — Anthropic Admin API 7-day rolling usage vs. ceiling
 *   claude_5h_overage — Anthropic Admin API 5-hour rolling usage vs. ceiling
 *   openrouter_daily  — OpenRouter daily credits consumed vs. limit
 *
 * Usage:
 *   ANTHROPIC_ADMIN_API_KEY=sk-ant-... OPENROUTER_API_KEY=sk-or-... \
 *     npx tsx scripts/quota-poller/poller.ts
 *
 * Environment:
 *   ANTHROPIC_ADMIN_API_KEY  (required)  Anthropic Admin API key
 *   OPENROUTER_API_KEY       (required)  OpenRouter API key
 *   ANTHROPIC_WEEKLY_CEILING (optional)  Weekly ceiling in USD  [default: 1000]
 *   ANTHROPIC_5H_CEILING     (optional)  5h rolling ceiling in USD  [default: 150]
 *   THRESHOLD_PCT            (optional)  Alert threshold %  [default: 80]
 */

import { env } from 'node:process'

/* -------------------------------------------------------------------------- */
/*  Logger                                                                    */
/* -------------------------------------------------------------------------- */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

function log(level: LogLevel, msg: string, context?: Record<string, unknown>) {
	const entry = { level, msg, timestamp: new Date().toISOString(), ...context }
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
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface QuotaEntry {
	used: number
	limit: number
	headroom_pct: number
	exceeded: boolean
}

export interface PollResult {
	timestamp: string
	threshold_pct: number
	quotas: Record<string, QuotaEntry>
	any_exceeded: boolean
	errors: Array<{ route: string; message: string; code: string }>
}

/* -------------------------------------------------------------------------- */
/*  Anthropic Admin API client                                                */
/* -------------------------------------------------------------------------- */

const ANTHROPIC_BASE = 'https://api.anthropic.com'

interface AnthropicUsageReport {
	usage: Array<{
		metric: string
		value: number
		period_start?: string
		period_end?: string
	}>
}

/**
 * Fetch the Anthropic usage report and compute headroom for configured ceilings.
 *
 * The Admin API returns usage data broken down by metric. We look for:
 * - `usage` entries matching 7-day and 5-hour rolling windows
 *
 * On any HTTP error (401, 403, 500, etc.) we log a structured error and
 * return null so the caller can skip this route without failing the whole poll.
 */
async function fetchAnthropicQuotas(
	apiKey: string,
	weeklyCeiling: number,
	fiveHourCeiling: number,
): Promise<{ claude_weekly: QuotaEntry; claude_5h_overage: QuotaEntry } | null> {
	const url = `${ANTHROPIC_BASE}/v1/organizations/usage_report`

	let response: Response
	try {
		response = await fetch(url, {
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
				'content-type': 'application/json',
			},
		})
	} catch (err) {
		logger.error('Anthropic API request failed', {
			route: 'claude',
			error: String(err),
			error_type: 'network',
		})
		return null
	}

	if (!response.ok) {
		const body = await response.text().catch(() => '')
		logger.error('Anthropic API returned non-OK status', {
			route: 'claude',
			status: response.status,
			status_text: response.statusText,
			body: body.slice(0, 500),
			error_type: response.status === 401 || response.status === 403 ? 'auth' : 'api',
		})
		return null
	}

	let report: AnthropicUsageReport
	try {
		report = (await response.json()) as AnthropicUsageReport
	} catch (err) {
		logger.error('Anthropic API returned invalid JSON', {
			route: 'claude',
			error: String(err),
			error_type: 'parse',
		})
		return null
	}

	const usageMap = new Map<string, number>()
	for (const entry of report.usage) {
		usageMap.set(entry.metric, entry.value)
	}

	const weeklyUsed = usageMap.get('total_usage_7d') ?? usageMap.get('total_usage') ?? 0
	const fiveHourUsed = usageMap.get('total_usage_5h') ?? usageMap.get('usage_5h') ?? 0

	const claude_weekly = computeQuota(weeklyUsed, weeklyCeiling)
	const claude_5h_overage = computeQuota(fiveHourUsed, fiveHourCeiling)

	return { claude_weekly, claude_5h_overage }
}

/* -------------------------------------------------------------------------- */
/*  OpenRouter client                                                         */
/* -------------------------------------------------------------------------- */

const OPENROUTER_BASE = 'https://openrouter.ai/api'

interface OpenRouterCreditsResponse {
	data?: {
		credits_used: number
		credits_used_total: number
		credits_limit: number
	}
	error?: { code: number; message: string }
}

/**
 * Fetch OpenRouter credit usage and compute daily headroom.
 *
 * Returns null on failure (invalid key, network error) so the poll can
 * continue with remaining routes.
 */
async function fetchOpenRouterQuota(
	apiKey: string,
): Promise<{ openrouter_daily: QuotaEntry } | null> {
	const url = `${OPENROUTER_BASE}/v1/credits`

	let response: Response
	try {
		response = await fetch(url, {
			headers: {
				authorization: `Bearer ${apiKey}`,
			},
		})
	} catch (err) {
		logger.error('OpenRouter API request failed', {
			route: 'openrouter',
			error: String(err),
			error_type: 'network',
		})
		return null
	}

	if (!response.ok) {
		const body = await response.text().catch(() => '')
		logger.error('OpenRouter API returned non-OK status', {
			route: 'openrouter',
			status: response.status,
			status_text: response.statusText,
			body: body.slice(0, 500),
			error_type: response.status === 401 || response.status === 403 ? 'auth' : 'api',
		})
		return null
	}

	let credits: OpenRouterCreditsResponse
	try {
		credits = (await response.json()) as OpenRouterCreditsResponse
	} catch (err) {
		logger.error('OpenRouter API returned invalid JSON', {
			route: 'openrouter',
			error: String(err),
			error_type: 'parse',
		})
		return null
	}

	if (credits.error) {
		logger.error('OpenRouter API returned error', {
			route: 'openrouter',
			code: credits.error.code,
			message: credits.error.message,
			error_type: 'api',
		})
		return null
	}

	const data = credits.data
	if (!data || typeof data.credits_limit !== 'number') {
		logger.error('OpenRouter API response missing credits data', {
			route: 'openrouter',
			error_type: 'parse',
		})
		return null
	}

	const used = data.credits_used
	const limit = data.credits_limit
	const openrouter_daily = computeQuota(used, limit)

	return { openrouter_daily }
}

/* -------------------------------------------------------------------------- */
/*  Quota helpers                                                             */
/* -------------------------------------------------------------------------- */

function computeQuota(used: number, limit: number): QuotaEntry {
	const headroom_pct = limit > 0 ? roundTo1((used / limit) * 100) : 0
	return {
		used: roundTo2(used),
		limit: roundTo2(limit),
		headroom_pct,
		exceeded: headroom_pct >= THRESHOLD_PCT,
	}
}

function roundTo1(n: number): number {
	return Math.round(n * 10) / 10
}

function roundTo2(n: number): number {
	return Math.round(n * 100) / 100
}

/* -------------------------------------------------------------------------- */
/*  Config                                                                    */
/* -------------------------------------------------------------------------- */

function readEnvFloat(key: string, fallback: number): number {
	const raw = env[key]
	if (raw === undefined || raw === '') return fallback
	const parsed = Number(raw)
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const ANTHROPIC_ADMIN_API_KEY = env.ANTHROPIC_ADMIN_API_KEY
const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY
const ANTHROPIC_WEEKLY_CEILING = readEnvFloat('ANTHROPIC_WEEKLY_CEILING', 1000)
const ANTHROPIC_5H_CEILING = readEnvFloat('ANTHROPIC_5H_CEILING', 150)
const THRESHOLD_PCT = readEnvFloat('THRESHOLD_PCT', 80)

/* -------------------------------------------------------------------------- */
/*  Main                                                                      */
/* -------------------------------------------------------------------------- */

async function main(): Promise<PollResult> {
	const errors: PollResult['errors'] = []
	const quotas: PollResult['quotas'] = {}

	if (!ANTHROPIC_ADMIN_API_KEY) {
		logger.error("ANTHROPIC_ADMIN_API_KEY not set — cannot poll Claude quotas")
		errors.push({
			route: "claude",
			message: "ANTHROPIC_ADMIN_API_KEY environment variable is not set",
			code: "MISSING_API_KEY",
		})
	} else {
		const result = await fetchAnthropicQuotas(
			ANTHROPIC_ADMIN_API_KEY,
			ANTHROPIC_WEEKLY_CEILING,
			ANTHROPIC_5H_CEILING,
		)
		if (result) {
			quotas.claude_weekly = result.claude_weekly
			quotas.claude_5h_overage = result.claude_5h_overage
		} else {
			errors.push({
				route: 'claude',
				message: 'Failed to fetch Anthropic quotas — see error log',
				code: 'ANTHROPIC_FETCH_FAILED',
			})
		}
	}

	if (!OPENROUTER_API_KEY) {
		logger.error("OPENROUTER_API_KEY not set — cannot poll OpenRouter quotas")
		errors.push({
			route: "openrouter",
			message: "OPENROUTER_API_KEY environment variable is not set",
			code: "MISSING_API_KEY",
		})
	} else {
		const result = await fetchOpenRouterQuota(OPENROUTER_API_KEY)
		if (result) {
			quotas.openrouter_daily = result.openrouter_daily
		} else {
			errors.push({
				route: 'openrouter',
				message: 'Failed to fetch OpenRouter quota — see error log',
				code: 'OPENROUTER_FETCH_FAILED',
			})
		}
	}

	const quotaEntries = Object.values(quotas)
	const any_exceeded = quotaEntries.some((q) => q.exceeded)

	const result: PollResult = {
		timestamp: new Date().toISOString(),
		threshold_pct: THRESHOLD_PCT,
		quotas,
		any_exceeded,
		errors,
	}

	if (any_exceeded) {
		const exceeded = Object.entries(quotas)
			.filter(([, q]) => q.exceeded)
			.map(([k]) => k)
		logger.warn('Quota threshold(s) exceeded', {
			exceeded,
			threshold_pct: THRESHOLD_PCT,
		})
	}

	logger.info('Poll complete', {
		routes_checked: Object.keys(quotas).length,
		any_exceeded,
		errors: errors.length,
	})

	return result
}

/* -------------------------------------------------------------------------- */
/*  Entry                                                                     */
/* -------------------------------------------------------------------------- */

// Detect whether this module is being run directly (not imported).
// Works when run via `node --experimental-strip-types`, `tsx`, or compiled JS.
const isMain =
	process.argv[1] &&
	(import.meta.url === `file://${process.argv[1]}` ||
		process.argv[1].endsWith('/poller.ts') ||
		process.argv[1].endsWith('/poller.js'))

if (isMain) {
	main()
		.then((result) => {
		const hasMissingKey = result.errors.some((e) => e.code === "MISSING_API_KEY")
		if (hasMissingKey) {
			process.exit(1)
		}
		process.stdout.write(JSON.stringify(result) + "\n")
		})
		.catch((err) => {
			logger.error('Unhandled poller error', { error: String(err) })
			process.exit(1)
		})
}
