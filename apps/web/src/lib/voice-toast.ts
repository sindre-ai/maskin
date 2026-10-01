/**
 * Post-call sonner toast — fired when a voice call ends. Copy is verbatim
 * from the Voice v1 design SPEC §Copy — do not paraphrase. Auto-dismiss at
 * 6s per the SPEC. The Open action navigates to the resumable Conversation
 * in `/chats/<conversation_id>`; the helper accepts a pre-built URL so the
 * caller controls workspace-scoping (avoids importing router state here).
 */

import { formatVoiceCallDuration } from '@/components/chat/voice-call-boundary'
import { toast } from 'sonner'

/** Verbatim SPEC strings — exported so tests can assert on the same source of truth. */
export const VOICE_CALL_ENDED_TITLE_PREFIX = 'Voice call ended · '
export const VOICE_CALL_ENDED_DESCRIPTION = (agentName: string) =>
	`Transcript saved to your chat with ${agentName}.`
export const VOICE_CALL_ENDED_OPT_OUT_DESCRIPTION =
	'This workspace opted out of transcript storage.'
export const VOICE_CALL_ENDED_OPEN_ACTION_LABEL = 'Open'
export const VOICE_CALL_ENDED_DURATION_MS = 6_000

export interface ShowVoiceCallEndedToastArgs {
	durationMs: number
	agentName: string
	/**
	 * Full URL (or path) to the resumable chat conversation. Optional — when
	 * absent (opt-out mode, or the conversation wasn't persisted for any other
	 * reason), the Open action is dropped and the description flips to the
	 * opt-out variant so the human isn't told a transcript exists that
	 * doesn't.
	 */
	conversationUrl?: string | null
	/** Router push — passed in so the toast doesn't take a router dependency. */
	onOpen?: (url: string) => void
}

export function showVoiceCallEndedToast({
	durationMs,
	agentName,
	conversationUrl,
	onOpen,
}: ShowVoiceCallEndedToastArgs): void {
	const title = `${VOICE_CALL_ENDED_TITLE_PREFIX}${formatVoiceCallDuration(durationMs)}`
	const hasTranscript = typeof conversationUrl === 'string' && conversationUrl.length > 0
	const description = hasTranscript
		? VOICE_CALL_ENDED_DESCRIPTION(agentName)
		: VOICE_CALL_ENDED_OPT_OUT_DESCRIPTION
	toast(title, {
		description,
		duration: VOICE_CALL_ENDED_DURATION_MS,
		action:
			hasTranscript && conversationUrl
				? {
						label: VOICE_CALL_ENDED_OPEN_ACTION_LABEL,
						onClick: () => onOpen?.(conversationUrl),
					}
				: undefined,
	})
}
