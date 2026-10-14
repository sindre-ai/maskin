import { capturePosthogEvent } from './posthog'

export interface CapabilityScanCompletedProps {
	workspace_id: string
	mode: 'baseline' | 'diff'
	sources_total: number
	sources_failed: number
	unscanned_servers: number
	tools_total: number
	tools_added: number
	tools_removed: number
	schema_changed: number
	findings_eligible: number
	duration_ms: number
	/** The scan is a server job. Always 0; kept as a field so a regression shows up. */
	model_calls: 0
}

/**
 * One event per workspace per tick, not one per integration. Counts only: no
 * tool names, no agent ids, no descriptions. The database twin is the
 * capability_scan_completed events row written in the same tick.
 */
export async function trackCapabilityScanCompleted(p: CapabilityScanCompletedProps): Promise<void> {
	await capturePosthogEvent('capability_scan_completed', p.workspace_id, { ...p })
}

export interface CapabilityNoteSentProps {
	workspace_id: string
	recipient_id: string
	conversation_id: string
	/** Findings the note covers. A count, never names. */
	findings: number
	/** Distinct agents named in the note. A count, never names. */
	agents_affected: number
}

/** One event per capability note actually delivered. Distinct id is the sending agent. */
export async function trackCapabilityNoteSent(
	agentId: string,
	p: CapabilityNoteSentProps,
): Promise<void> {
	await capturePosthogEvent('capability_note_sent', agentId, { ...p })
}

/** A recipient who had something to hear and did not get a note this tick. */
export async function trackCapabilityNoteSkipped(agentId: string, reason: string): Promise<void> {
	await capturePosthogEvent('capability_note_skipped', agentId, { reason })
}

export interface AgentChatStartedMessageProps {
	agent_id: string
	human_id: string
	conversation_id: string
	reason: string
	/** Hours since the last message of any kind in the chat; null for an empty chat. */
	hours_since_last_message: number | null
}

/**
 * An agent started a message in a person's chat. Fired only by
 * sendProactiveMessage, after every cap has passed and the message is stored,
 * so a multi-message reply can never count.
 */
export async function trackAgentChatStartedMessage(p: AgentChatStartedMessageProps): Promise<void> {
	await capturePosthogEvent('agent_chat_started_message', p.agent_id, { ...p })
}

/** sendProactiveMessage said no. Reason is the refusal code, never content. */
export async function trackAgentChatMessageRefused(agentId: string, reason: string): Promise<void> {
	await capturePosthogEvent('agent_chat_message_refused', agentId, { reason })
}
