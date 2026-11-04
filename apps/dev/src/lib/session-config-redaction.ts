import { MASKED_VALUE, maskArgs, maskUrlPassword } from './actor-tools-redaction'

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function maskValues(values: unknown): unknown {
	if (!isRecord(values)) return values
	return Object.fromEntries(Object.keys(values).map((key) => [key, MASKED_VALUE]))
}

function maskMcp(mcp: unknown): unknown {
	if (!isRecord(mcp)) return mcp
	return {
		...mcp,
		...(Array.isArray(mcp.args) && { args: maskArgs(mcp.args) }),
		...(typeof mcp.url === 'string' && { url: maskUrlPassword(mcp.url) }),
		...(mcp.env !== undefined && { env: maskValues(mcp.env) }),
		...(mcp.headers !== undefined && { headers: maskValues(mcp.headers) }),
	}
}

/**
 * Copy of a stored session config with every value under env_vars, mcps[].env
 * and mcps[].headers replaced by MASKED_VALUE, the secret part of mcps[].args
 * masked as for actor tools, and a password in mcps[].url masked. Keys and shape stay. For the HTTP
 * response only: the session manager reads the raw config straight from the table.
 */
export function redactSessionConfig(config: unknown): unknown {
	if (!isRecord(config)) return config
	return {
		...config,
		...(config.env_vars !== undefined && { env_vars: maskValues(config.env_vars) }),
		...(Array.isArray(config.mcps) && { mcps: config.mcps.map(maskMcp) }),
	}
}
