import type { Database } from '@maskin/db'
import { events as eventsTable } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { Cron } from 'croner'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { resolveSlackBotToken } from '../lib/integrations/providers/slack/bot-token'
import { slackPostMessage } from '../lib/integrations/providers/slack/mcp-server'
import { logger } from '../lib/logger'

/**
 * Channels the founders can name in their reply. Anything not on this list
 * collapses into `'other'` — the dashboard only needs a Claude / ChatGPT
 * breakdown plus a residual bucket for ad-hoc tools.
 */
export type ExternalChatProvider = 'claude' | 'chatgpt' | 'other'

export interface FounderReporterConfigEntry {
	/** Maskin actor UUID — becomes the PostHog `distinct_id` so the dashboard joins per founder. */
	actorId: string
	/** Display name used in the reminder DM, e.g. "Sebastian". */
	name: string
	/** Slack user ID like `U0123ABC` — passed to chat.postMessage so Slack auto-opens the DM channel. */
	slackUserId: string
}

export interface FounderReporterConfig {
	workspaceId: string
	founders: FounderReporterConfigEntry[]
}

const configSchema = z.object({
	workspaceId: z.string().uuid(),
	founders: z
		.array(
			z.object({
				actorId: z.string().uuid(),
				name: z.string().min(1),
				slackUserId: z.string().regex(/^[UW][A-Z0-9]+$/),
			}),
		)
		.min(1),
})

const PROVIDER_KEY_MAP: Record<string, ExternalChatProvider> = {
	claude: 'claude',
	c: 'claude',
	chatgpt: 'chatgpt',
	cg: 'chatgpt',
	gpt: 'chatgpt',
	other: 'other',
	o: 'other',
}

const TOKEN_REGEX = /([a-zA-Z]+)\s*(?:=|:)\s*(\d+)/g
const DATE_REGEX = /\bdate\s*(?:=|:)\s*(\d{4}-\d{2}-\d{2})\b/i

const DEFAULT_CRON_EXPRESSION = '0 17 * * *'
const DEFAULT_TIMEZONE = 'Europe/Oslo'
const POSTHOG_EVENT_NAME = 'external_chat_session_reported'

export interface ParsedExternalChatReport {
	reportDate: string
	entries: Array<{ provider: ExternalChatProvider; sessionCount: number }>
}

/**
 * Parse a Slack reply into a normalised external-chat report.
 *
 * Accepted shapes (case-insensitive, order-free):
 *   - `claude=3 chatgpt=1 other=0`
 *   - `Claude: 3, ChatGPT: 1`
 *   - `date=2026-06-17 claude=3 chatgpt=1`
 *
 * Returns `null` when no `provider=count` token can be extracted — keeps the
 * listener from spamming PostHog with zero-signal events on chitchat replies.
 * `defaultReportDate` is used when no explicit `date=` prefix is present.
 */
export function parseExternalChatReport(
	text: string,
	defaultReportDate: string,
): ParsedExternalChatReport | null {
	if (typeof text !== 'string' || text.trim().length === 0) return null

	const dateMatch = DATE_REGEX.exec(text)
	const reportDate = dateMatch?.[1] ?? defaultReportDate

	// Per-provider so a duplicated key (e.g. `claude=3 c=4`) takes the last value
	// rather than emitting both — last write wins matches the user's likely intent
	// when they're correcting themselves mid-message.
	const collected = new Map<ExternalChatProvider, number>()
	for (const match of text.matchAll(TOKEN_REGEX)) {
		const keyRaw = match[1]?.toLowerCase()
		const valueRaw = match[2]
		if (!keyRaw || !valueRaw) continue
		if (keyRaw === 'date') continue
		const provider = PROVIDER_KEY_MAP[keyRaw] ?? 'other'
		const count = Number(valueRaw)
		if (!Number.isFinite(count) || count < 0) continue
		// `other` is additive across unknown tokens so two ad-hoc tools sum up.
		if (provider === 'other' && PROVIDER_KEY_MAP[keyRaw] !== 'other') {
			collected.set('other', (collected.get('other') ?? 0) + count)
		} else {
			collected.set(provider, count)
		}
	}

	if (collected.size === 0) return null

	return {
		reportDate,
		entries: Array.from(collected.entries()).map(([provider, sessionCount]) => ({
			provider,
			sessionCount,
		})),
	}
}

export function formatReminderMessage(name: string, reportDate: string): string {
	return [
		`Hey ${name} — daily founder check-in for ${reportDate}.`,
		'',
		'How many chat sessions did you start today in Claude / ChatGPT / other?',
		'Reply in this shape (omit zeros if you want): `claude=3 chatgpt=1 other=0`.',
		'Backdate by prefixing `date=YYYY-MM-DD` if you missed yesterday.',
		'',
		'This feeds the Maskin-as-default founder-substitution share.',
	].join('\n')
}

/**
 * Resolve the report date from a Slack `event.ts` (seconds since epoch as a
 * string like "1718635200.000100") in the configured timezone, or fall back to
 * "now". Founders typically reply within the same hour, but a delayed reply
 * should still attribute to the *send* day, not the read day.
 */
function dateInTimezone(d: Date, timezone: string): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(d)
	const year = parts.find((p) => p.type === 'year')?.value
	const month = parts.find((p) => p.type === 'month')?.value
	const day = parts.find((p) => p.type === 'day')?.value
	if (!year || !month || !day) {
		// Fallback to UTC slice — Intl should never miss these parts, but the
		// `??` guards keep the caller's `report_date` non-null even on a busted
		// runtime.
		return d.toISOString().slice(0, 10)
	}
	return `${year}-${month}-${day}`
}

export interface ReporterOptions {
	bridge: PgNotifyBridge
	db: Database
	/**
	 * Raw config string — usually `process.env.FOUNDER_EXTERNAL_REPORT_CONFIG`.
	 * When unset/invalid the reporter starts silently and does nothing, so the
	 * dev stack boots cleanly without founder credentials configured.
	 */
	configJson: string | undefined
	cronExpression?: string
	timezone?: string
	/** Used in the Slack `username` subscript on outbound reminder DMs. */
	machineIconUrl?: string
	/** Override for tests. */
	now?: () => Date
}

interface NormalisedSlackMessageEvent {
	user?: string
	text?: string
	subtype?: string
	ts?: string
	channel?: string
}

function normaliseSlackMessageEvent(
	data: Record<string, unknown> | null,
): NormalisedSlackMessageEvent | null {
	if (!data) return null
	const inner = (data as { event?: unknown }).event
	if (!inner || typeof inner !== 'object') return null
	const e = inner as Record<string, unknown>
	return {
		user: typeof e.user === 'string' ? e.user : undefined,
		text: typeof e.text === 'string' ? e.text : undefined,
		subtype: typeof e.subtype === 'string' ? e.subtype : undefined,
		ts: typeof e.ts === 'string' ? e.ts : undefined,
		channel: typeof e.channel === 'string' ? e.channel : undefined,
	}
}

/**
 * Daily founder-substitution capture mechanism for the Maskin-as-default bet.
 *
 * Two halves:
 *   1. Cron — at 17:00 in `Europe/Oslo` (or the configured timezone), DMs each
 *      configured founder via the workspace's Slack bot token, asking for the
 *      day's Claude/ChatGPT/other chat-session count.
 *   2. Listener — subscribes to PG NOTIFY for `slack.direct_message` events,
 *      filters by the configured founder Slack user IDs, parses the message,
 *      and fires one `external_chat_session_reported` per provider mentioned.
 *
 * Both halves are no-ops when `FOUNDER_EXTERNAL_REPORT_CONFIG` is unset — the
 * dev stack boots without founder credentials and CI doesn't spuriously page
 * a non-existent Slack workspace.
 */
export class FounderExternalChatReporter {
	private bridge: PgNotifyBridge
	private db: Database
	private config: FounderReporterConfig | null
	private cronExpression: string
	private timezone: string
	private machineIconUrl: string | undefined
	private now: () => Date
	private cronJob: Cron | null = null
	private eventHandler: ((event: PgEvent) => void) | null = null
	private founderBySlackId: Map<string, FounderReporterConfigEntry> = new Map()

	constructor(options: ReporterOptions) {
		this.bridge = options.bridge
		this.db = options.db
		this.cronExpression = options.cronExpression ?? DEFAULT_CRON_EXPRESSION
		this.timezone = options.timezone ?? DEFAULT_TIMEZONE
		this.machineIconUrl = options.machineIconUrl
		this.now = options.now ?? (() => new Date())
		this.config = parseConfig(options.configJson)
		if (this.config) {
			for (const founder of this.config.founders) {
				this.founderBySlackId.set(founder.slackUserId, founder)
			}
		}
	}

	start(): void {
		if (!this.config) {
			logger.debug('Founder external-chat reporter inactive — FOUNDER_EXTERNAL_REPORT_CONFIG unset')
			return
		}

		this.eventHandler = (event) => {
			this.handleEvent(event).catch((err) =>
				logger.error('Founder external-chat reporter: event handling failed', {
					error: err instanceof Error ? err.message : String(err),
					eventId: event.event_id,
				}),
			)
		}
		this.bridge.on('event', this.eventHandler)

		try {
			this.cronJob = new Cron(this.cronExpression, { timezone: this.timezone }, () => {
				this.runDailyReminder().catch((err) =>
					logger.error('Founder external-chat reporter: cron tick failed', {
						error: err instanceof Error ? err.message : String(err),
					}),
				)
			})
		} catch (err) {
			logger.error('Founder external-chat reporter: invalid cron expression', {
				expression: this.cronExpression,
				timezone: this.timezone,
				error: err instanceof Error ? err.message : String(err),
			})
		}

		logger.info('Founder external-chat reporter started', {
			workspaceId: this.config.workspaceId,
			founders: this.config.founders.length,
			cron: this.cronExpression,
			timezone: this.timezone,
		})
	}

	stop(): void {
		if (this.eventHandler) {
			this.bridge.off('event', this.eventHandler)
			this.eventHandler = null
		}
		if (this.cronJob) {
			this.cronJob.stop()
			this.cronJob = null
		}
	}

	/** Public for unit tests — fires the same DM batch the cron triggers. */
	async runDailyReminder(): Promise<void> {
		if (!this.config) return
		const resolved = await resolveSlackBotToken(this.db, this.config.workspaceId)
		if (!resolved) {
			logger.warn('Founder external-chat reporter: no active Slack bot token, skipping DMs', {
				workspaceId: this.config.workspaceId,
			})
			return
		}

		const reportDate = dateInTimezone(this.now(), this.timezone)
		const ctx = {
			botToken: resolved.botToken,
			agentLabel: 'Maskin · founder substitution',
			machineIconUrl: this.machineIconUrl,
			workspaceId: this.config.workspaceId,
			actorId: 'founder-external-chat-reporter',
			slackTeamId: resolved.slackTeamId,
		}

		let sent = 0
		let failed = 0
		for (const founder of this.config.founders) {
			try {
				await slackPostMessage(ctx, {
					channel: founder.slackUserId,
					text: formatReminderMessage(founder.name, reportDate),
				})
				sent++
			} catch (err) {
				failed++
				logger.error('Founder external-chat reporter: reminder DM failed', {
					founder: founder.name,
					slackUserId: founder.slackUserId,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}

		logger.info('Founder external-chat reporter: reminder DMs dispatched', {
			workspaceId: this.config.workspaceId,
			reportDate,
			sent,
			failed,
		})
	}

	/** Public for unit tests — runs the same path the PG NOTIFY listener runs. */
	async handleEvent(event: PgEvent): Promise<void> {
		if (!this.config) return
		if (event.workspace_id !== this.config.workspaceId) return
		if (event.entity_type !== 'slack.direct_message') return
		if (event.action !== 'created') return

		// NOTIFY payloads are stripped of `data` for the 8KB limit, so the Slack
		// message body lives in the events row — fetch it lazily and bail if the
		// row was already trimmed (shouldn't happen, but don't crash if it does).
		const [row] = await this.db
			.select({ data: eventsTable.data })
			.from(eventsTable)
			.where(eq(eventsTable.id, Number(event.event_id)))
			.limit(1)
		const message = normaliseSlackMessageEvent(
			(row?.data as Record<string, unknown> | null) ?? null,
		)
		if (!message) return

		// Slack re-emits message_changed / message_deleted as `subtype` variants
		// of the same `message` event type — skip everything but the original
		// human send so an edit doesn't double-count.
		if (message.subtype && message.subtype !== 'file_share') return
		if (!message.user) return
		const founder = this.founderBySlackId.get(message.user)
		if (!founder) return
		if (!message.text) return

		const tsSeconds = Number(message.ts ?? '')
		const replyDate = Number.isFinite(tsSeconds) ? new Date(tsSeconds * 1000) : this.now()
		const defaultReportDate = dateInTimezone(replyDate, this.timezone)
		const parsed = parseExternalChatReport(message.text, defaultReportDate)
		if (!parsed) return

		for (const entry of parsed.entries) {
			await capturePosthogEvent(POSTHOG_EVENT_NAME, founder.actorId, {
				workspace_id: this.config.workspaceId,
				actor_id: founder.actorId,
				actor_type: 'human',
				provider: entry.provider,
				session_count: entry.sessionCount,
				report_date: parsed.reportDate,
				source: 'slack',
			})
		}

		logger.info('Founder external-chat reporter: ingested report', {
			workspaceId: this.config.workspaceId,
			actorId: founder.actorId,
			reportDate: parsed.reportDate,
			providers: parsed.entries.map((e) => `${e.provider}=${e.sessionCount}`).join(','),
		})
	}
}

function parseConfig(raw: string | undefined): FounderReporterConfig | null {
	const trimmed = raw?.trim()
	if (!trimmed) return null
	try {
		const parsed = JSON.parse(trimmed)
		const validated = configSchema.parse(parsed)
		return validated
	} catch (err) {
		logger.error('Founder external-chat reporter: invalid FOUNDER_EXTERNAL_REPORT_CONFIG', {
			error: err instanceof Error ? err.message : String(err),
		})
		return null
	}
}
