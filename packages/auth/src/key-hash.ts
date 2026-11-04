import { createHash } from 'node:crypto'

/**
 * Hex SHA-256 of the full token. Plain and unsalted on purpose: keys are 122 random bits, so
 * a slow hash adds nothing, and the lookup has to stay one indexed equality.
 */
export function hashApiKey(apiKey: string): string {
	return createHash('sha256').update(apiKey).digest('hex')
}
