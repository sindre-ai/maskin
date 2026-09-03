export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
export const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
/**
 * Who a subscription token belongs to. Takes the subscription's OAuth access
 * token as a bearer token — its own 401 says "Please provide an OAuth token as
 * a Bearer token" — and needs no scope beyond what that token already carries.
 * Read best-effort for display only; see `fetchClaudeAccount`.
 */
export const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
