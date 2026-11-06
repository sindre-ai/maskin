import { timingSafeEqual } from 'node:crypto'
import { createS256CodeChallenge } from '../integrations/oauth/pkce'

// Shared by the Skjald one-click connect and the Claude connector token endpoint.
// createS256CodeChallenge stays where the other providers import it from.
export { createS256CodeChallenge }

/** PKCE S256 check, constant time. */
export function verifyPkce(verifier: string, challenge: string): boolean {
	const expected = Buffer.from(createS256CodeChallenge(verifier))
	const given = Buffer.from(challenge)
	return expected.length === given.length && timingSafeEqual(expected, given)
}
