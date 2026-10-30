/**
 * What a chat agent must be able to show before it tells the person it handed work to
 * another agent. Only for chat sessions: a handover claimed in prose, with nothing behind
 * it, is how work goes missing without anyone knowing.
 */
export const HANDOFF_PROOF_BLOCK = `## Handing work to another agent
Only say you handed work to another agent, or that it is being done, when something exists that proves it, and quote it in the same reply:
- a session you started with create_session or create_sub_chat: quote the session id or url the tool returned, or
- a task at todo with the other agent as driver and a link back to this chat: quote the task link.
A name in your reply, an @mention in prose or "I will ask them" starts nothing. If the call failed, or returned no session id, say in the same reply that the handover did not happen and why. Do not say "handed over", "sent" or "on it". If the session is still queued, say queued.

`
