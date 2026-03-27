import { createPrivateKey, createSign } from 'node:crypto'
import type { CustomAuthHandler, StoredCredentials } from '../../types'

function getEnvOrThrow(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`${name} environment variable is required`)
	return value
}

function createJwt(appId: string, privateKeyPem: string): string {
	const now = Math.floor(Date.now() / 1000)
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
	const payload = Buffer.from(
		JSON.stringify({
			iat: now - 60,
			exp: now + 600,
			iss: Number(appId),
		}),
	).toString('base64url')

	// Use createPrivateKey to normalize any PEM format (PKCS#1 or PKCS#8) for OpenSSL 3
	const key = createPrivateKey(privateKeyPem)
	const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key, 'base64url')

	return `${header}.${payload}.${signature}`
}

/**
 * Parse a PEM private key from env, handling multiple formats:
 * 1. Literal \n sequences (common in .env files)
 * 2. Spaces instead of newlines (Coolify and other platforms collapse newlines to spaces)
 * 3. Base64-encoded PEM
 */
function parsePrivateKey(raw: string): string {
	if (raw.includes('-----BEGIN')) {
		const normalized = raw.replace(/\\n/g, '\n').replace(/\\r/g, '')
		const match = normalized.match(
			/(-----BEGIN [\w ]+-----)\s+([\s\S]+?)\s+(-----END [\w ]+-----)/,
		)
		if (match) {
			const [, header, body = '', footer] = match
			const bodyLines = body.split(/\s+/).join('\n')
			return `${header}\n${bodyLines}\n${footer}\n`
		}
		return normalized
	}
	return Buffer.from(raw, 'base64').toString('utf8')
}

export const githubAuth: CustomAuthHandler = {
	getInstallUrl(state: string): string {
		return `https://github.com/apps/${process.env.GITHUB_APP_SLUG || 'ai-native-oss'}/installations/new?state=${encodeURIComponent(state)}`
	},

	async handleCallback(params: Record<string, string>): Promise<StoredCredentials> {
		const installationId = params.installation_id
		if (!installationId) {
			throw new Error('Missing installation_id in callback')
		}
		return { installation_id: installationId }
	},

	async getAccessToken(credentials: StoredCredentials): Promise<string> {
		const appId = getEnvOrThrow('GITHUB_APP_ID')
		const privateKeyRaw = getEnvOrThrow('GITHUB_APP_PRIVATE_KEY')
		const privateKey = parsePrivateKey(privateKeyRaw)
		const jwt = createJwt(appId, privateKey)

		const response = await fetch(
			`https://api.github.com/app/installations/${credentials.installation_id}/access_tokens`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${jwt}`,
					Accept: 'application/vnd.github+json',
					'X-GitHub-Api-Version': '2022-11-28',
				},
			},
		)

		if (!response.ok) {
			const text = await response.text()
			throw new Error(`Failed to get installation access token: ${response.status} ${text}`)
		}

		const data = (await response.json()) as { token: string }
		return data.token
	},
}
