import type { ResolvedProvider } from './types'

import { githubAuth } from './providers/github/auth'
// Import provider configs
import { config as githubConfig } from './providers/github/config'
import { githubEventNormalizer } from './providers/github/webhooks'
import {
	config as slackConfig,
	parseTokenResponse as slackParseTokenResponse,
	resolveExternalId as slackResolveExternalId,
	slackWebhookPreHandler,
} from './providers/slack/config'
import { slackEventNormalizer } from './providers/slack/webhooks'

const providers = new Map<string, ResolvedProvider>()

// ── Register providers ─────────────────────────────────────────────────────

providers.set('github', {
	config: githubConfig,
	customAuth: githubAuth,
	customNormalizer: githubEventNormalizer,
})

providers.set('slack', {
	config: slackConfig,
	parseTokenResponse: slackParseTokenResponse,
	resolveExternalId: slackResolveExternalId,
	customNormalizer: slackEventNormalizer,
	webhookPreHandler: slackWebhookPreHandler,
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
