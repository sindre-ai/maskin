import type { BotProvider } from './types.js'

const botProviders = new Map<string, BotProvider>()

/** Register a bot provider */
export function registerBotProvider(provider: BotProvider): void {
	botProviders.set(provider.name, provider)
}

/** Get a bot provider by name */
export function getBotProvider(name: string): BotProvider | undefined {
	return botProviders.get(name)
}

/** List all registered bot providers */
export function listBotProviders(): BotProvider[] {
	return Array.from(botProviders.values())
}
