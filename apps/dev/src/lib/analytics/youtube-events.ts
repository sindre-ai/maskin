import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

export const YOUTUBE_TOOL_CALLED = 'youtube_tool_called'
export const YOUTUBE_ACTION_DECIDED = 'youtube_action_decided'

// The part of the YouTube bet each tool ships in. The part number is derived from the tool name
// here, so a caller cannot send a mismatched pair, and the tool name is always one of ours: never
// free text from an agent.
const TOOL_PART = {
	get_channel: 1,
	get_video_stats: 1,
	list_recent_videos: 1,
	search: 2,
	get_public_channel: 2,
	get_public_videos: 2,
	list_comments: 2,
	get_own_captions: 2,
	get_analytics: 3,
	update_video_metadata: 4,
	set_thumbnail: 4,
	create_playlist: 4,
	add_to_playlist: 4,
	post_comment: 4,
	reply_to_comment: 4,
	like: 4,
	upload_video: 5,
	publish_video: 5,
	get_upload_status: 5,
} as const

export type YoutubeToolName = keyof typeof TOOL_PART

/** Write tools only: the kinds of action that wait for a person. */
export type YoutubeActionKind =
	| 'update_video_metadata'
	| 'set_thumbnail'
	| 'create_playlist'
	| 'add_to_playlist'
	| 'post_comment'
	| 'reply_to_comment'
	| 'like'
	| 'upload_video'
	| 'publish_video'

/** How a tool call ended. A category, never an error string. */
export type YoutubeOutcome =
	| 'ok'
	| 'quota_blocked'
	| 'not_connected'
	| 'invalid_input'
	| 'upstream_error'
	| 'pending_approval'

export type YoutubeDecision = 'approved' | 'rejected' | 'expired'

export interface YoutubeToolCalledProps {
	workspaceId: string
	/** The agent that called the tool; the distinct id. */
	agentId: string
	sessionId: string | null
	/** The tool name without the youtube__ prefix. */
	tool: YoutubeToolName
	outcome: YoutubeOutcome
	/** The calling session was started by a flow trigger, not a person's chat. */
	viaLoop: boolean
}

export interface YoutubeActionDecidedProps {
	workspaceId: string
	/** The person who decided; null when the action expired with no decision. */
	decidedBy: string | null
	kind: YoutubeActionKind
	decision: YoutubeDecision
	/** When the pending action was created, and when it was decided or expired. */
	requestedAt: Date
	decidedAt: Date
}

/** Whole hours from request to decision, rounded down and never below zero. */
export function wholeHoursToDecide(requestedAt: Date, decidedAt: Date): number {
	const ms = decidedAt.getTime() - requestedAt.getTime()
	return Math.max(0, Math.floor(ms / 3_600_000))
}

/**
 * One event per youtube__ tool call. Ids, counts, booleans and categories only: never a video
 * title, comment text, channel name or error string. Best-effort: never throws, so callers fire
 * it without awaiting.
 */
export async function trackYoutubeToolCalled(p: YoutubeToolCalledProps): Promise<void> {
	const part = TOOL_PART[p.tool]
	if (!part) {
		logger.warn('youtube_tool_called skipped: unknown tool', { tool: String(p.tool) })
		return
	}
	try {
		await capturePosthogEvent(YOUTUBE_TOOL_CALLED, p.agentId, {
			workspace_id: p.workspaceId,
			agent_id: p.agentId,
			session_id: p.sessionId,
			tool: p.tool,
			part,
			outcome: p.outcome,
			via_loop: p.viaLoop,
		})
	} catch (err) {
		logger.warn('Failed to emit youtube_tool_called', {
			workspaceId: p.workspaceId,
			error: String(err),
		})
	}
}

/**
 * One event per approval decision on a held YouTube write. The safety line "no public action
 * without approval" is read from the approval audit table, not from this event. Best-effort.
 */
export async function trackYoutubeActionDecided(p: YoutubeActionDecidedProps): Promise<void> {
	try {
		await capturePosthogEvent(YOUTUBE_ACTION_DECIDED, p.decidedBy ?? p.workspaceId, {
			workspace_id: p.workspaceId,
			kind: p.kind,
			decision: p.decision,
			hours_to_decide: wholeHoursToDecide(p.requestedAt, p.decidedAt),
		})
	} catch (err) {
		logger.warn('Failed to emit youtube_action_decided', {
			workspaceId: p.workspaceId,
			error: String(err),
		})
	}
}
