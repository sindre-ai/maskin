/**
 * Pure rule-resolution helpers for the dispatch poller. No DB, no I/O.
 *
 * Rule shapes (ported from skjald `calendar-scheduler.ts` `matchesAllRules`):
 *   - `all`           — join every meeting
 *   - `external_only` — join only when ≥1 attendee email is outside the
 *                       workspace's domain list
 *   - `pattern`       — match the meeting title against include/exclude
 *                       substrings (case-insensitive)
 *
 * Per-meeting `metadata.autoJoin: true | false` always wins over the workspace
 * default. The `false` case is what lets a user opt a specific meeting out of
 * an otherwise-permissive workspace policy.
 */

export type JoinPolicy =
	| { kind: 'all' }
	| { kind: 'never' }
	| { kind: 'external_only'; workspaceDomains?: string[] }
	| { kind: 'pattern'; titleIncludes?: string[]; titleExcludes?: string[] }

export interface MeetingForPolicy {
	id: string
	title: string | null
	status: string
	metadata: Record<string, unknown> | null
}

export interface WorkspaceForPolicy {
	id: string
	settings: Record<string, unknown> | null
}

export interface NotetakerWorkspaceSettings {
	defaultJoin?: JoinPolicy
}

export interface DispatchDecision {
	dispatch: boolean
	/** Human-readable reason, included in poller logs and skipped-meeting telemetry. */
	reason: string
}

const DEFAULT_POLICY: JoinPolicy = { kind: 'all' }

export function readNotetakerSettings(workspace: WorkspaceForPolicy): NotetakerWorkspaceSettings {
	const settings = workspace.settings
	if (!settings || typeof settings !== 'object') return {}
	const block = (settings as Record<string, unknown>).notetaker
	if (!block || typeof block !== 'object') return {}
	return block as NotetakerWorkspaceSettings
}

export function readMeetingMetadata(meeting: MeetingForPolicy) {
	const md = (meeting.metadata ?? {}) as Record<string, unknown>
	return {
		startTime: typeof md.startTime === 'string' ? Date.parse(md.startTime) : undefined,
		autoJoin: typeof md.autoJoin === 'boolean' ? md.autoJoin : undefined,
		attendeeEmails: Array.isArray(md.attendeeEmails)
			? (md.attendeeEmails.filter((v): v is string => typeof v === 'string') as string[])
			: [],
		skjaldBotId: typeof md.skjaldBotId === 'string' ? md.skjaldBotId : undefined,
		meetingUrl: typeof md.meetingUrl === 'string' ? md.meetingUrl : undefined,
		botName: typeof md.botName === 'string' ? md.botName : undefined,
	}
}

export function isInLeadWindow(
	startTimeMs: number | undefined,
	nowMs: number,
	leadWindowMs: number,
): boolean {
	if (!startTimeMs || !Number.isFinite(startTimeMs)) return false
	// Dispatch when we're inside [startTime - leadWindow, startTime]. We don't
	// chase meetings whose startTime has already passed by more than the lead
	// window — those are stale and the calendar provider should have flipped
	// their status by now.
	const diff = startTimeMs - nowMs
	return diff <= leadWindowMs && diff >= -leadWindowMs
}

function emailDomain(email: string): string | undefined {
	const at = email.lastIndexOf('@')
	if (at < 0) return undefined
	return email.slice(at + 1).toLowerCase()
}

function matchesPolicy(
	meeting: MeetingForPolicy,
	policy: JoinPolicy,
): { match: boolean; reason: string } {
	switch (policy.kind) {
		case 'all':
			return { match: true, reason: 'workspace policy=all' }
		case 'never':
			return { match: false, reason: 'workspace policy=never' }
		case 'external_only': {
			const md = readMeetingMetadata(meeting)
			const domains = (policy.workspaceDomains ?? []).map((d) => d.toLowerCase())
			if (md.attendeeEmails.length === 0) {
				return { match: false, reason: 'external_only: no attendees on meeting' }
			}
			const hasExternal = md.attendeeEmails.some((e) => {
				const d = emailDomain(e)
				return d !== undefined && !domains.includes(d)
			})
			return hasExternal
				? { match: true, reason: 'external_only: external attendee present' }
				: { match: false, reason: 'external_only: all attendees internal' }
		}
		case 'pattern': {
			const title = (meeting.title ?? '').toLowerCase()
			const includes = (policy.titleIncludes ?? []).map((s) => s.toLowerCase())
			const excludes = (policy.titleExcludes ?? []).map((s) => s.toLowerCase())
			if (excludes.some((s) => title.includes(s))) {
				return { match: false, reason: 'pattern: title matched exclude' }
			}
			if (includes.length === 0) {
				return { match: true, reason: 'pattern: no includes configured' }
			}
			if (includes.some((s) => title.includes(s))) {
				return { match: true, reason: 'pattern: title matched include' }
			}
			return { match: false, reason: 'pattern: no includes matched' }
		}
	}
}

/**
 * Decide whether a single meeting should be dispatched right now.
 *
 * Returns `dispatch: false` whenever the meeting is missing a `meetingUrl`,
 * already has a `skjaldBotId`, is outside the lead window, or the resolved
 * policy says no.
 */
export function resolveDispatch(
	meeting: MeetingForPolicy,
	workspace: WorkspaceForPolicy,
	nowMs: number,
	leadWindowMs: number,
): DispatchDecision {
	const md = readMeetingMetadata(meeting)
	if (md.skjaldBotId) {
		return { dispatch: false, reason: 'already dispatched' }
	}
	if (!md.meetingUrl) {
		return { dispatch: false, reason: 'no meetingUrl on meeting' }
	}
	if (!isInLeadWindow(md.startTime, nowMs, leadWindowMs)) {
		return { dispatch: false, reason: 'outside lead window' }
	}
	if (md.autoJoin === true) {
		return { dispatch: true, reason: 'per-meeting autoJoin=true' }
	}
	if (md.autoJoin === false) {
		return { dispatch: false, reason: 'per-meeting autoJoin=false' }
	}
	const ws = readNotetakerSettings(workspace)
	const policy = ws.defaultJoin ?? DEFAULT_POLICY
	const { match, reason } = matchesPolicy(meeting, policy)
	return { dispatch: match, reason }
}
