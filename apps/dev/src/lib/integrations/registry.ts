import type { ResolvedProvider } from './types'

import { githubAuth } from './providers/github/auth'
// Import provider configs
import { config as githubConfig } from './providers/github/config'
import { githubEventNormalizer } from './providers/github/webhooks'
import { config as googleCalendarConfig } from './providers/google-calendar/config'
import { config as recallConfig, verifyRecallWebhook } from './providers/recall/config'
import { recallEventNormalizer } from './providers/recall/webhooks'

const providers = new Map<string, ResolvedProvider>()

// ── Register providers ─────────────────────────────────────────────────────

providers.set('github', {
	config: githubConfig,
	customAuth: githubAuth,
	customNormalizer: githubEventNormalizer,
})

providers.set('recall', {
	config: recallConfig,
	customWebhookVerifier: verifyRecallWebhook,
	customNormalizer: recallEventNormalizer,
})

providers.set('google-calendar', {
	config: googleCalendarConfig,
})

// ── Public API ─────────────────────────────────────────────────────────────

export function getProvider(name: string): ResolvedProvider {
	const provider = providers.get(name)
	if (!provider) {
		throw new Error(`Unknown integration provider: ${name}`)
	}
	return provider
}

export function listProviders(): ResolvedProvider[] {
	return Array.from(providers.values())
}
