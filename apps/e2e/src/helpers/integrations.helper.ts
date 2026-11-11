import type { Locator, Page } from '@playwright/test'

/**
 * A connected integration or tool server is a collapsed card; its status line, actions and agent
 * access sit behind the chevron. Open it by name. `scope` narrows the search (a section locator).
 */
export async function openIntegrationCard(scope: Page | Locator, name: RegExp | string) {
	const matcher = typeof name === 'string' ? new RegExp(name) : name
	await scope.getByRole('button', { name: matcher, expanded: false }).click()
}

/** Unconnected providers are listed under the Discover tab. */
export async function openDiscover(page: Page) {
	await page.getByRole('button', { name: /^Discover \(\d+\)$/ }).click()
}
