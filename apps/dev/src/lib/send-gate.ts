import type { Database } from '@maskin/db'
import type { SendPermissionMode } from '@maskin/shared'
import { resolveSendMode } from './send-permissions'

/**
 * What a send tool does with a call, once the integration level has let it through (Read and
 * No access never reach here; the access gate refuses them first):
 *
 *   send_now        Read & write with the kind set to always_allow: the agent's call goes out
 *                   as given, with no draft, card or wait
 *   needs_approval  the kind is set to ask_first: nothing goes out until a person approved the
 *                   exact text of a draft (card, edit then approve, or a yes in the chat)
 *   denied          the kind is set to deny: nothing goes out, whatever the agent says
 *
 * The setting is per agent and per draft kind, read now on every call (see send-permissions.ts).
 * A caller with no database handle cannot be resolved and is treated as ask_first, so a
 * missing handle never widens what sends.
 */
export type SendDecision = 'send_now' | 'needs_approval' | 'denied'

const DECISIONS: Record<SendPermissionMode, SendDecision> = {
	always_allow: 'send_now',
	ask_first: 'needs_approval',
	deny: 'denied',
}

export async function decideSend(
	db: Database | undefined,
	params: { workspaceId: string; agentId: string; kind: string },
): Promise<SendDecision> {
	if (!db) return 'needs_approval'
	const { mode } = await resolveSendMode(db, params)
	return DECISIONS[mode]
}

/** The refusal for a send the person set to deny. Same wording for every provider. */
export function deniedMessage(what: string): string {
	return `Sending ${what} is turned off for this agent in the workspace's send settings. Nothing was sent. Do not retry or look for another way to send it; ask a person to change the setting if it should be on.`
}

/**
 * Appended to an ask-first refusal. Tells the agent the whole path in one go, including that a
 * person's yes in the chat counts the same as a tap on the card.
 */
export const ASK_FIRST_STEPS =
	'This agent is set to ask first for this kind of send. Save the exact text as a task or object with the right metadata.kind, link it in the chat or put it on a decision card, and ask the person. They can edit the text on the card before approving, or just say yes in the chat (then call approve_draft_from_chat). Once it is approved, call this tool again with only object_id. Nothing was sent.'
