import type { ResolvedProvider } from './types'

import { githubAuth } from './providers/github/auth'
// Import provider configs
import { config as githubConfig } from './providers/github/config'
import { githubEventNormalizer } from './providers/github/webhooks'
import { config as googleCalendarConfig } from './providers/google-calendar/config'
import {
	config as linearConfig,
	resolveExternalId as linearResolveExternalId,
} from './providers/linear/config'
import { linearEventNormalizer } from './providers/linear/webhooks'
import { config as microsoftOutlookConfig } from './providers/microsoft-outlook/config'
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

providers.set('linear', {
	config: linearConfig,
	customNormalizer: linearEventNormalizer,
	resolveExternalId: linearResolveExternalId,
})

providers.set('slack', {
	config: slackConfig,
	parseTokenResponse: slackParseTokenResponse,
	resolveExternalId: slackResolveExternalId,
	customNormalizer: slackEventNormalizer,
	webhookPreHandler: slackWebhookPreHandler,
})

providers.set('google-calendar', {
	config: googleCalendarConfig,
})

providers.set('microsoft-outlook', {
	config: microsoftOutlookConfig,
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
