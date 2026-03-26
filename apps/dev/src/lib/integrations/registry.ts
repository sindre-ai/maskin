import { GitHubProvider } from './github'
import { GoogleCalendarProvider } from './google-calendar'
import { RecallIntegrationProvider } from './recall'
import type { IntegrationProvider } from './types'

const providers = new Map<string, IntegrationProvider>()

// Register built-in providers
providers.set('github', new GitHubProvider())
providers.set('google_calendar', new GoogleCalendarProvider())
providers.set('recall', new RecallIntegrationProvider())

export function getProvider(name: string): IntegrationProvider {
	const provider = providers.get(name)
	if (!provider) {
		throw new Error(`Unknown integration provider: ${name}`)
	}
	return provider
}

export function listProviders(): IntegrationProvider[] {
	return Array.from(providers.values())
}
