import { GitHubProvider } from './github'
import type { IntegrationProvider } from './types'

const providers = new Map<string, IntegrationProvider>()

// Register built-in providers
providers.set('github', new GitHubProvider())

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
