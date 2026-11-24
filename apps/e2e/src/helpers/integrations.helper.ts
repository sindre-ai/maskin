import type { Locator, Page } from '@playwright/test'

/**
 * A connected integration or tool server is a collapsed card; its status line, actions and agent
 * access sit behind the chevron. Open it by name. `scope` narrows the search (a section locator).
 */
export async function openIntegrationCard(scope: Page | Locator, name: RegExp | string) {
	const matcher = typeof name === 'string' ? new RegExp(name) : name
	await scope.getByRole('button', { name: matcher, expanded: false }).click()
}

/**
 * Unconnected providers are compact rows on the same page. Scroll to the All integrations list, the
 * one place every unconnected tool appears once (Popular and New repeat some on purpose), and hand it
 * back to narrow later lookups.
 */
export async function openDiscover(page: Page) {
	const list = page.getByRole('region', { name: 'All integrations' })
	await list.scrollIntoViewIfNeeded()
	return list
}
