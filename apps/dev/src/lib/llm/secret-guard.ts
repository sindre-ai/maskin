import { findHighConfidenceSecret } from '@maskin/shared'
import type { LLMAdapter } from './adapter'

export class RawSecretRefusedError extends Error {
	constructor(readonly patternId: string) {
		super(`Refusing to send a message that matches the ${patternId} secret pattern`)
		this.name = 'RawSecretRefusedError'
	}
}

/**
 * Belt and braces behind the composer guard and the POST /messages backstop: no
 * adapter forwards a message that matches a high-confidence secret pattern. The
 * error names the pattern only, never the matched text.
 */
export function withSecretGuard(adapter: LLMAdapter): LLMAdapter {
	return {
		async chat(options) {
			for (const message of options.messages) {
				const hit = findHighConfidenceSecret(message.content)
				if (hit) throw new RawSecretRefusedError(hit.patternId)
			}
			return adapter.chat(options)
		},
	}
}
