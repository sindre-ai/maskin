import type { Database } from '@maskin/db'
import { objects, workspaces } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import {
	type MeetingForPolicy,
	type WorkspaceForPolicy,
	readMeetingMetadata,
	resolveDispatch,
} from './policy.js'
import { type DispatchResponse, type SkjaldClientOptions, dispatchToSkjald } from './skjald.js'

export interface PollerConfig {
	skjaldUrl: string
	apiKey: string
	/** Poll cadence in ms. Default: 60s. */
	intervalMs?: number
	/** How close to `startTime` (in ms) we dispatch. Default: 2min. */
	leadWindowMs?: number
	/** Injected for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch
	/** Injected clock; defaults to `Date.now`. */
	now?: () => number
	/** Logger hook; defaults to JSON-on-stdout. */
	log?: (level: 'info' | 'warn' | 'error', msg: string, ctx?: Record<string, unknown>) => void
}

const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_LEAD_WINDOW_MS = 2 * 60_000

function defaultLog(
	level: 'info' | 'warn' | 'error',
	msg: string,
	ctx?: Record<string, unknown>,
): void {
	const line = JSON.stringify({
		level,
		msg,
		timestamp: new Date().toISOString(),
		...ctx,
	})
	if (level === 'error') console.error(line)
	else console.log(line)
}

export interface TickResult {
	scanned: number
	dispatched: number
	failed: number
	skipped: number
}

/**
 * Global poller — single instance per process, scans `meeting` objects across
 * ALL workspaces (spec D7). Tasks T7/T8 will create the meetings (via the
 * `google-calendar` provider) and attendees (via M5); this just reads what's
 * on the row, decides whether to dispatch, and writes `skjaldBotId` back on
 * success.
 */
export class NotetakerDispatchPoller {
	private timer: NodeJS.Timeout | null = null
	private running = false
	private readonly intervalMs: number
	private readonly leadWindowMs: number
	private readonly fetchImpl: typeof fetch
	private readonly now: () => number
	private readonly log: NonNullable<PollerConfig['log']>

	constructor(
		private readonly db: Database,
		private readonly config: PollerConfig,
	) {
		this.intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS
		this.leadWindowMs = config.leadWindowMs ?? DEFAULT_LEAD_WINDOW_MS
		this.fetchImpl = config.fetchImpl ?? fetch
		this.now = config.now ?? (() => Date.now())
		this.log = config.log ?? defaultLog
	}

	start(): void {
		if (this.timer) return
		this.log('info', 'Notetaker dispatch poller started', {
			intervalMs: this.intervalMs,
			leadWindowMs: this.leadWindowMs,
			skjaldUrl: this.config.skjaldUrl,
		})
		this.timer = setInterval(() => {
			void this.tick()
		}, this.intervalMs)
		// First sweep shortly after boot — same pattern as gmail-watch-renewer.
		setTimeout(() => {
			void this.tick()
		}, 5_000).unref?.()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	/** Public for tests — runs a single sweep synchronously. */
	async tick(): Promise<TickResult> {
		if (this.running) {
			return { scanned: 0, dispatched: 0, failed: 0, skipped: 0 }
		}
		this.running = true
		const result: TickResult = { scanned: 0, dispatched: 0, failed: 0, skipped: 0 }
		try {
			const rows = await this.db
				.select()
				.from(objects)
				.where(and(eq(objects.type, 'meeting'), eq(objects.status, 'scheduled')))
			result.scanned = rows.length
			if (rows.length === 0) return result

			const workspaceIds = Array.from(new Set(rows.map((r) => r.workspaceId)))
			const wsRows = await Promise.all(
				workspaceIds.map((id) =>
					this.db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1),
				),
			)
			const workspaceById = new Map<string, WorkspaceForPolicy>()
			for (const [i, ws] of wsRows.entries()) {
				const id = workspaceIds[i]
				if (!id) continue
				const row = ws[0]
				workspaceById.set(id, {
					id,
					settings: (row?.settings ?? null) as Record<string, unknown> | null,
				})
			}
			const nowMs = this.now()
			const skjaldOpts: SkjaldClientOptions = {
				skjaldUrl: this.config.skjaldUrl,
				apiKey: this.config.apiKey,
				fetchImpl: this.fetchImpl,
			}
			for (const row of rows) {
				const meeting: MeetingForPolicy = {
					id: row.id,
					title: row.title,
					status: row.status,
					metadata: (row.metadata as Record<string, unknown> | null) ?? null,
				}
				const workspace = workspaceById.get(row.workspaceId) ?? {
					id: row.workspaceId,
					settings: null,
				}
				const decision = resolveDispatch(meeting, workspace, nowMs, this.leadWindowMs)
				if (!decision.dispatch) {
					result.skipped++
					continue
				}
				const md = readMeetingMetadata(meeting)
				try {
					const response: DispatchResponse = await dispatchToSkjald(skjaldOpts, {
						meetingUrl: md.meetingUrl as string,
						botName: md.botName,
						maskinMeetingId: meeting.id,
						maskinWorkspaceId: workspace.id,
					})
					await this.persistDispatch(row.id, response)
					result.dispatched++
					this.log('info', 'Notetaker dispatched meeting', {
						meetingId: meeting.id,
						workspaceId: workspace.id,
						skjaldBotId: response.skjaldBotId,
						reason: decision.reason,
					})
				} catch (err) {
					result.failed++
					this.log('error', 'Notetaker dispatch failed', {
						meetingId: meeting.id,
						workspaceId: workspace.id,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
			if (result.dispatched > 0 || result.failed > 0) {
				this.log('info', 'Notetaker poller tick', result as unknown as Record<string, unknown>)
			}
			return result
		} catch (err) {
			this.log('error', 'Notetaker poller tick crashed', {
				error: err instanceof Error ? err.message : String(err),
			})
			return result
		} finally {
			this.running = false
		}
	}

	private async persistDispatch(meetingId: string, response: DispatchResponse): Promise<void> {
		// Re-read so we merge into the existing metadata (the meeting may have
		// other fields the calendar provider wrote that we must not clobber).
		const existing = await this.db.select().from(objects).where(eq(objects.id, meetingId)).limit(1)
		const current = existing[0]
		if (!current) return
		const mergedMetadata = {
			...((current.metadata as Record<string, unknown> | null) ?? {}),
			skjaldBotId: response.skjaldBotId,
		}
		await this.db
			.update(objects)
			.set({ status: 'in_progress', metadata: mergedMetadata, updatedAt: new Date() })
			.where(eq(objects.id, meetingId))
	}
}
