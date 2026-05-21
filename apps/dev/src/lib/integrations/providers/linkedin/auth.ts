import type { CustomAuthHandler, StoredCredentials } from '../../types'

export const linkedinAuth: CustomAuthHandler = {
	// LinkedIn does not use the standard /api/integrations/:provider/connect → install URL flow.
	// The frontend recognizes the linkedin provider on the integrations page and opens the
	// browser-streaming modal instead of calling POST /connect. This method exists only to
	// satisfy the CustomAuthHandler interface; calling it indicates a misuse of the API.
	getInstallUrl(_state: string): string {
		throw new Error(
			'LinkedIn does not use the standard install-URL flow — POST /api/integrations/linkedin/auth-browser/start instead',
		)
	},

	// Called by the auth-browser flow once Chromium has captured the session cookies.
	// Expects: { li_at, jsessionid?, profile_url? }
	async handleCallback(params: Record<string, string>): Promise<StoredCredentials> {
		const liAt = params.li_at
		if (!liAt) {
			throw new Error('Missing li_at cookie in callback')
		}
		const credentials: StoredCredentials = { li_at: liAt }
		if (params.jsessionid) credentials.jsessionid = params.jsessionid
		if (params.profile_url) credentials.profile_url = params.profile_url
		return credentials
	},

	// Called by session-manager when injecting LINKEDIN_TOKEN into agent containers.
	// Returns a Cookie-header-formatted string the forked MCP server consumes via env.
	async getAccessToken(credentials: StoredCredentials): Promise<string> {
		const liAt = typeof credentials.li_at === 'string' ? credentials.li_at : undefined
		if (!liAt) {
			throw new Error('LinkedIn credentials missing li_at')
		}
		const parts = [`li_at=${liAt}`]
		const jsessionid =
			typeof credentials.jsessionid === 'string' ? credentials.jsessionid : undefined
		if (jsessionid) {
			parts.push(`JSESSIONID="${jsessionid}"`)
		}
		return parts.join('; ')
	},
}
