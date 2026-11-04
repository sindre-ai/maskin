export {
	BYO_APIKEY_ENV_SEGMENT,
	BYO_LOGIN_ENV_SEGMENT,
	KEYCHAIN_ENV_PREFIX,
	byoApiKeyEnvName,
	byoLoginEnvNames,
} from '@maskin/shared'

/**
 * Env var key prefixes whose values never reach a log line. KEYCHAIN_ is the
 * Keychain's own; INTEGRATION_TOKEN_ and BYO_ are reserved so a later naming
 * change cannot start logging a value by accident.
 */
export const REDACTED_ENV_PREFIXES = ['KEYCHAIN_', 'INTEGRATION_TOKEN_', 'BYO_'] as const

export function isRedactedEnvKey(key: string): boolean {
	return REDACTED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
}

/**
 * What the container-start log says about the launch env. A value is never
 * included: the env also carries MCP config JSON with literal tokens and the
 * agent's own API key, so a prefix-only rule would leak the rest. Keys under a
 * redacted prefix read [redacted], every other key reads [set].
 */
export function redactLaunchEnv(env: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.keys(env)
			.sort()
			.map((key) => [key, isRedactedEnvKey(key) ? '[redacted]' : '[set]']),
	)
}
