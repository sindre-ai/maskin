import type { ResolvedProvider } from './types'

import { githubAuth } from './providers/github/auth'
// Import provider configs
import { config as githubConfig } from './providers/github/config'
import { githubEventNormalizer } from './providers/github/webhooks'
import { config as gmailConfig } from './providers/gmail/config'
import { resolveExternalId as gmailResolveExternalId } from './providers/gmail/resolve-id'
import { fanOutGmailHistory, setupGmailWatch, stopGmailWatch } from './providers/gmail/watch'
import { gmailEventNormalizer, gmailWebhookVerifier } from './providers/gmail/webhooks'
import { config as googleCalendarConfig } from './providers/google-calendar/config'
import { revokeGoogleCalendarGrant } from './providers/google-calendar/disconnect'
import { resolveExternalId as googleCalendarResolveExternalId } from './providers/google-calendar/resolve-id'
import {
	config as linearConfig,
	resolveExternalId as linearResolveExternalId,
} from './providers/linear/config'
import { linearEventNormalizer } from './providers/linear/webhooks'
import { config as posthogConfig } from './providers/posthog/config'
import {
	config as slackConfig,
	slackExtractDeliveryId,
	parseTokenResponse as slackParseTokenResponse,
	resolveExternalId as slackResolveExternalId,
	slackWebhookPreHandler,
} from './providers/slack/config'
import { slackWebhookFanOut } from './providers/slack/fan-out'
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
	extractDeliveryId: slackExtractDeliveryId,
	webhookFanOut: slackWebhookFanOut,
	// File downloads can blow past Slack's 3s ack budget; process them off the
	// hot path. The delivery claim still happens sync so retries are deduped.
	asyncProcessing: true,
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

providers.set('google-calendar', {
	config: googleCalendarConfig,
	resolveExternalId: googleCalendarResolveExternalId,
	preDisconnect: revokeGoogleCalendarGrant,
})

providers.set('posthog', {
	config: posthogConfig,
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
