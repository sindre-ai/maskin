/**
 * Detect an integration whose stored credential predates a scope the provider
 * config now requires.
 *
 * OAuth tokens do not gain scopes retroactively: when a provider config grows a
 * scope, every existing install keeps a perfectly valid token that simply cannot
 * do the new thing. Nothing in the platform noticed this before — `credentials.
 * scope` was written on connect and never read back — so the only signal a user
 * got was a raw `missing_scope` from the provider at the moment they tried to
 * use the feature, with nothing saying that reconnecting fixes it.
 *
 * Kept provider-agnostic because the gap is platform-wide, even though Slack's
 * history + search scopes are what forced the issue.
 */

import type { ProviderConfig } from './types'

/**
 * Split a stored scope string into a set.
 *
 * Providers are inconsistent: Slack returns comma-separated scopes, most others
 * space-separated. Splitting on both is correct for either and harmless for a
 * provider that uses only one, since neither character is legal inside a scope.
 */
export function parseScopes(granted: string | undefined | null): Set<string> {
	if (!granted) return new Set()
	return new Set(
		granted
			.split(/[,\s]+/)
			.map((s) => s.trim())
			.filter(Boolean),
	)
}

/**
 * Which of `required` is absent from `granted`.
 *
 * Returns them in the order they appear in `required` so the message a user sees
 * matches the order the provider config declares, rather than set-iteration
 * order. An empty result means the install is current.
 */
export function missingScopes(
	granted: string | undefined | null,
	required: readonly string[],
): string[] {
	const have = parseScopes(granted)
	return required.filter((scope) => !have.has(scope))
}

/**
 * Compare one integration's stored credential against what its provider config
 * declares today.
 *
 * Checks the bot/app scopes (`credentials.scope` vs `auth.config.scopes`) and
 * any user scopes separately, because they are granted as two independent lists
 * in the same OAuth round-trip and stored under different keys — Slack's
 * `user_scope` being the case that forced this. A token can satisfy one and not
 * the other.
 *
 * Only providers using the standard `oauth2` flow are checked: `api_key` has no
 * scopes, and `oauth2_custom` providers (GitHub Apps) derive permissions from
 * the app installation rather than a scope string, so a comparison here would
 * produce false positives.
 *
 * An install with NO stored scope string at all is reported as current, not as
 * missing everything. `OAuth2Handler` only persists `scope` when the provider
 * answers with a string, and not every provider does — Linear returns it as a
 * JSON array, so its credentials carry no scope at all. Treating that as "zero
 * scopes granted" would light the Reconnect banner on every Linear install and
 * keep it lit, because reconnecting produces another credential with no scope
 * string either. Absent means unknown, and we cannot claim drift we have not
 * observed.
 *
 * The bot scope string doubles as the signal that a provider records scopes at
 * all, which is what makes the user-scope check safe: once we have seen one, an
 * absent `userScope` genuinely means no user scopes were granted — exactly the
 * pre-`user_scope` Slack install the Reconnect prompt is for.
 */
export function integrationScopeGaps(
	config: ProviderConfig,
	credentials: { scope?: unknown; userScope?: unknown },
): { missing: string[]; needsReconnect: boolean } {
	if (config.auth.type !== 'oauth2') return { missing: [], needsReconnect: false }

	const grantedScope = typeof credentials.scope === 'string' ? credentials.scope : undefined
	if (grantedScope === undefined) return { missing: [], needsReconnect: false }

	const grantedUserScope =
		typeof credentials.userScope === 'string' ? credentials.userScope : undefined

	const missing = missingScopes(grantedScope, config.auth.config.scopes)

	const requiredUserScopes = parseScopes(config.auth.config.extraAuthParams?.user_scope)
	for (const scope of missingScopes(grantedUserScope, [...requiredUserScopes])) {
		missing.push(scope)
	}

	return { missing, needsReconnect: missing.length > 0 }
}
