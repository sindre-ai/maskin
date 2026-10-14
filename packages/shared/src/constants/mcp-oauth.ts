// OAuth for the MCP server (Claude connector). Lifetimes are constants, not env.
// There is deliberately no absolute grant lifetime: a grant lives until it is
// revoked, its member is removed, or its refresh token goes unused for 30 days.
export const OAUTH_SCOPE = 'mcp'
export const OAUTH_ACCESS_TTL_S = 3600
export const OAUTH_REFRESH_TTL_S = 2592000
export const OAUTH_CODE_TTL_S = 60

export const OAUTH_ACCESS_TOKEN_PREFIX = 'mat_'
export const OAUTH_REFRESH_TOKEN_PREFIX = 'mrt_'
