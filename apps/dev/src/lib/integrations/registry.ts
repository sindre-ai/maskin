import { logger } from '../logger'
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
import { config as googleMeetConfig } from './providers/google-meet/config'
import { resolveExternalId as googleMeetResolveExternalId } from './providers/google-meet/resolve-id'
import {
	config as linearConfig,
	resolveExternalId as linearResolveExternalId,
} from './providers/linear/config'
import { linearEventNormalizer } from './providers/linear/webhooks'
import { config as linkedinConfig } from './providers/linkedin-unipile/config'
import { config as posthogConfig } from './providers/posthog/config'
import { config as skjaldConfig } from './providers/skjald/config'
import { reapSlackUserLinks } from './providers/slack/account-link'
import {
	config as slackConfig,
	slackExtractDeliveryId,
	parseTokenResponse as slackParseTokenResponse,
	resolveExternalId as slackResolveExternalId,
	slackWebhookPreHandler,
} from './providers/slack/config'
import {
	removeSlackDefaultTriggers,
	seedSlackDefaultTriggers,
} from './providers/slack/default-triggers'
import { slackWebhookFanOut } from './providers/slack/fan-out'
import { probeSlackTierOnInstall } from './providers/slack/tier-cache'
import { slackEventNormalizer } from './providers/slack/webhooks'
import { ubersuggestAuth } from './providers/ubersuggest/auth'
import { config as ubersuggestConfig } from './providers/ubersuggest/config'

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
	// Seed the tier cache, then the default @mention / DM responder triggers —
	// without them, mention events sit unconsumed and the bot never answers.
	// Both are fail-soft internally.
	postInstall: async (ctx) => {
		await probeSlackTierOnInstall(ctx)
		await seedSlackDefaultTriggers(ctx)
	},
	// On disconnect, reap slack_user_links rows for this team/workspace pair so
	// the next mention re-prompts (AC-T5), and remove the seeded default
	// triggers (kept if another Slack team is still connected). Best-effort —
	// never blocks the disconnect even if the table read fails.
	preDisconnect: async (ctx) => {
		await reapSlackUserLinks(ctx)
		await removeSlackDefaultTriggers(ctx)
	},
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

// google-meet — provider registration only. The webhook verifier + normalizer,
// Workspace Events subscription lifecycle, watch-renewer, and MCP tool surface
// all land in Task 3 (`d1ced369` — read-path MCP tools + async ingest). Wiring
// the provider here now:
//  - lets `google-meet` appear in `GET /api/integrations/providers` on day one,
//  - exercises the generic OAuth machinery + `INTEGRATION_ENCRYPTION_KEY`
//    decrypt path against a new Google provider (bet smokes S1 + S3),
//  - lets the callback route persist `config.meet.peopleId` (S12 smoke),
//  - keeps the row workspace-scoped like Gmail / GCal — Meet is deliberately
//    NOT added to `actorScopedProviders` in `lib/integrations/lookup.ts`.
// `postInstall` is a log-and-return stub; Task 3 replaces it with the real
// `setupMeetWatch` that opens the Workspace Events subscription.
providers.set('google-meet', {
	config: googleMeetConfig,
	resolveExternalId: googleMeetResolveExternalId,
	postInstall: async (ctx) => {
		logger.info('Google Meet postInstall stub (Task 3 replaces with setupMeetWatch)', {
			integrationId: ctx.integrationId,
			workspaceId: ctx.workspaceId,
		})
	},
})

providers.set('posthog', {
	config: posthogConfig,
})

providers.set('skjald', {
	config: skjaldConfig,
})

providers.set('ubersuggest', {
	config: ubersuggestConfig,
	customAuth: ubersuggestAuth,
})

// linkedin-unipile — the connect + callback flow is LinkedIn's Hosted Auth
// Wizard, not OAuth2. The provider is registered here (so it appears in
// GET /api/integrations/providers alongside the others) but the connect
// route lives at apps/dev/src/routes/integrations-linkedin-unipile.ts and
// is mounted BEFORE the generic /api/integrations route in app-factory.ts
// so the specific prefix wins the trie. The generic connect handler must
// NOT run for this provider — it would try to build an OAuth2 authorization
// URL and fail.
providers.set('linkedin-unipile', {
	config: linkedinConfig,
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
