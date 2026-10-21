import { createHash, randomBytes, randomInt } from 'node:crypto'
import { USER_CODE_ALPHABET, USER_CODE_LENGTH } from '@maskin/shared'

/** SHA-256, hex. Both codes are looked up by this and never stored in the clear. */
export function hashCode(code: string): string {
	return createHash('sha256').update(code).digest('hex')
}

/** The secret the device polls with: 32 random bytes, so it cannot be guessed. */
export function generateDeviceCode(): string {
	return randomBytes(32).toString('base64url')
}

/** The short code a person types: uniformly random over the unambiguous alphabet (`randomInt`
 * rejects modulo bias). Returned unformatted, e.g. "BCDF2345". */
export function generateUserCode(): string {
	let code = ''
	for (let i = 0; i < USER_CODE_LENGTH; i++) {
		code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]
	}
	return code
}
