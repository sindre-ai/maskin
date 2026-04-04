/**
 * Parse the contents of ~/.claude/.credentials.json and extract the Claude OAuth tokens.
 * Returns null if the JSON doesn't contain valid claudeAiOauth data.
 */
export function parseClaudeCredentials(jsonString: string): ParsedClaudeCredentials | null {
	try {
		const data = JSON.parse(jsonString)
		const oauth = data.claudeAiOauth
		if (!oauth?.accessToken || !oauth?.refreshToken) return null
		return {
			accessToken: oauth.accessToken,
			refreshToken: oauth.refreshToken,
			expiresAt: oauth.expiresAt ?? 0,
			subscriptionType: oauth.subscriptionType,
			scopes: oauth.scopes,
		}
	} catch {
		return null
	}
}

export interface ParsedClaudeCredentials {
	accessToken: string
	refreshToken: string
	expiresAt: number
	subscriptionType?: string
	scopes?: string[]
}

/**
 * Get the terminal command to copy credentials based on platform.
 */
export function getCredentialsCommand(): string {
	const ua = navigator.userAgent.toLowerCase()
	if (ua.includes('win')) {
		return 'type %USERPROFILE%\\.claude\\.credentials.json'
	}
	return 'cat $HOME/.claude/.credentials.json'
}
