/**
 * Masks the Keychain keys a session was given before its log lines are stored.
 *
 * A key reaches the agent as a KEYCHAIN_BYO_APIKEY_ env var. If the agent prints it or hands it
 * to a tool, the value would sit in plain text in session_logs. The values are read once, at
 * launch, and held here in memory for that session only: never written, logged or measured.
 * This limits what is stored. The model has already seen anything it printed.
 *
 * A session that was given no key stores its lines unchanged.
 */
import { createKeychainMasker, redactTokenShapes } from '@maskin/shared'

export class SessionLogRedactor {
	private maskers = new Map<string, (text: string) => string>()

	/** Hold the key values a session was launched with. A relaunch replaces the earlier set. */
	register(sessionId: string, keychainEnv: Record<string, string>): void {
		const masker = createKeychainMasker(keychainEnv)
		if (masker) this.maskers.set(sessionId, masker)
		else this.maskers.delete(sessionId)
	}

	/**
	 * The text with this session's keys swapped for a placeholder naming the credential, then
	 * token-shaped strings masked as a second net (a token minted from a key is not the key).
	 */
	redact(sessionId: string, text: string): string {
		const mask = this.maskers.get(sessionId)
		return mask ? redactTokenShapes(mask(text)) : text
	}

	forget(sessionId: string): void {
		this.maskers.delete(sessionId)
	}
}

export const sessionLogRedactor = new SessionLogRedactor()
