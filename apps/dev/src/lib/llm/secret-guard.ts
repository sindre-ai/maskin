import { findHighConfidenceSecret } from '@maskin/shared'

export class RawSecretRefusedError extends Error {
	constructor(readonly patternId: string) {
		super(`Refusing to send a message that matches the ${patternId} secret pattern`)
		this.name = 'RawSecretRefusedError'
	}
}

/**
 * Belt and braces behind the composer guard and the POST /messages backstop: every
 * adapter calls this before it builds a request, so no message that matches a
 * high-confidence secret pattern is forwarded to a provider. The error names the
 * pattern only, never the matched text. It throws synchronously, so call it inside
 * an async chat() and it surfaces as a rejected promise like any other failure.
 */
export function assertNoRawSecrets(messages: readonly { content: string }[]): void {
	for (const message of messages) {
		const hit = findHighConfidenceSecret(message.content)
		if (hit) throw new RawSecretRefusedError(hit.patternId)
	}
}
