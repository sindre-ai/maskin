/**
 * How long an interactive conversation session may sit with no log activity
 * before the watchdog closes it gracefully. Idle chats hold one of the agent
 * server's session slots, so a long window starves queued background work.
 *
 * Override with CHAT_IDLE_CLOSE_MINUTES (whole minutes, 1..1440). Anything
 * else falls back to the default rather than stopping the server.
 */
export const DEFAULT_CHAT_IDLE_CLOSE_MINUTES = 15

export function resolveChatIdleCloseMs(
	raw: string | undefined = process.env.CHAT_IDLE_CLOSE_MINUTES,
): number {
	const minutes = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw)
	const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440
	return (valid ? minutes : DEFAULT_CHAT_IDLE_CLOSE_MINUTES) * 60 * 1000
}
