import { createPrivateKey, createSign } from 'node:crypto'
import { getEnvOrThrow } from '../../env'

/**
 * Parse a PEM private key from env, handling multiple formats:
 * 1. Literal \n sequences (common in .env files)
 * 2. Spaces instead of newlines (Coolify and other platforms collapse newlines to spaces)
 * 3. Base64-encoded PEM
 */
export function parsePrivateKey(raw: string): string {
	if (raw.includes('-----BEGIN')) {
		const normalized = raw.replace(/\\n/g, '\n').replace(/\\r/g, '')
		const match = normalized.match(/(-----BEGIN [\w ]+-----)\s+([\s\S]+?)\s+(-----END [\w ]+-----)/)
		if (match) {
			const [, header, body = '', footer] = match
			const bodyLines = body.split(/\s+/).join('\n')
			return `${header}\n${bodyLines}\n${footer}\n`
		}
		return normalized
	}
	return Buffer.from(raw, 'base64').toString('utf8')
}

/**
 * Build a signed JWT for GitHub App authentication (RS256, 10-minute lifetime,
 * 60-second past-skew iat). Accepts any GitHub App's numeric id + PEM private key.
 */
export function createAppJwt(appId: string, privateKeyPem: string): string {
	const now = Math.floor(Date.now() / 1000)
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
	const payload = Buffer.from(
		JSON.stringify({
			iat: now - 60,
			exp: now + 600,
			iss: Number(appId),
		}),
	).toString('base64url')

	const key = createPrivateKey(privateKeyPem)
	const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key, 'base64url')

	return `${header}.${payload}.${signature}`
}

/**
 * Mint an App JWT from env-var-referenced App id and PEM private key. Each App
 * (customer-facing `sindre-maskin`, unattended-agent `sindre-ai-agents`, etc.)
 * gets its own credential pair so revocation of one never rolls the other.
 */
export function mintAppJwtFromEnv(idEnvName: string, keyEnvName: string): string {
	const appId = getEnvOrThrow(idEnvName)
	const privateKeyRaw = getEnvOrThrow(keyEnvName)
	const privateKey = parsePrivateKey(privateKeyRaw)
	return createAppJwt(appId, privateKey)
}
