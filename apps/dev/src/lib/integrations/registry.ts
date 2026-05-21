import type { ResolvedProvider } from './types'

import { githubAuth } from './providers/github/auth'
// Import provider configs
import { config as githubConfig } from './providers/github/config'
import { githubEventNormalizer } from './providers/github/webhooks'
import { config as gmailConfig } from './providers/gmail/config'
import { resolveExternalId as gmailResolveExternalId } from './providers/gmail/resolve-id'
import { fanOutGmailHistory, setupGmailWatch, stopGmailWatch } from './providers/gmail/watch'
import { gmailEventNormalizer, gmailWebhookVerifier } from './providers/gmail/webhooks'
import {
	config as linearConfig,
	resolveExternalId as linearResolveExternalId,
} from './providers/linear/config'
import { linearEventNormalizer } from './providers/linear/webhooks'
import { linkedinAuth } from './providers/linkedin/auth'
import { config as linkedinConfig } from './providers/linkedin/config'
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

providers.set('linkedin', {
	config: linkedinConfig,
	customAuth: linkedinAuth,
})

providers.set('slack', {
	config: slackConfig,
	parseTokenResponse: slackParseTokenResponse,
	resolveExternalId: slackResolveExternalId,
	customNormalizer: slackEventNormalizer,
	webhookPreHandler: slackWebhookPreHandler,
})

providers.set('gmail', {
	config: gmailConfig,
	customWebhookVerifier: gmailWebhookVerifier,
	customNormalizer: gmailEventNormalizer,
	resolveExternalId: gmailResolveExternalId,
	postInstall: setupGmailWatch,
	webhookFanOut: fanOutGmailHistory,
	preDisconnect: stopGmailWatch,
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
