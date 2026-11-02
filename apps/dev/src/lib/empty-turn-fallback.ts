import { MODEL_NAME_RE } from '@maskin/shared'
import { logger } from './logger'

/**
 * The model an interactive chat turn is retried on when the session's own model
 * keeps returning an empty completion (CHAT_EMPTY_TURN_FALLBACK_MODEL, an
 * OpenRouter slug such as deepseek/deepseek-v4-flash).
 *
 * Null when unset or invalid, which turns the fallback off and leaves the
 * same-model retries and the visible "try again" message in place. An invalid
 * value is logged rather than thrown: this runs at boot, and a typo in an
 * optional setting must not take the server down.
 */
export function readEmptyTurnFallbackModel(env: NodeJS.ProcessEnv = process.env): string | null {
	const raw = env.CHAT_EMPTY_TURN_FALLBACK_MODEL?.trim()
	if (!raw) return null
	if (!MODEL_NAME_RE.test(raw)) {
		logger.warn('Ignoring CHAT_EMPTY_TURN_FALLBACK_MODEL: not a valid model name', { value: raw })
		return null
	}
	return raw
}
