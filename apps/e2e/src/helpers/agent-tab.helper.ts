import { type Page, expect } from '@playwright/test'

export type AgentTab = 'overview' | 'sessions' | 'setup' | 'triggers' | 'computer'

const TAB_LABEL: Record<AgentTab, RegExp> = {
	overview: /^Overview/,
	sessions: /^Sessions/,
	setup: /^Setup/,
	triggers: /^Triggers/,
	computer: /^Computer/,
}

/**
 * Open a tab on the agent detail page. Clicks the tab by role, so it works on
 * touch viewports too, and is a no-op when the tab is already selected.
 */
export async function openAgentTab(page: Page, tab: AgentTab): Promise<void> {
	const trigger = page.getByRole('tab', { name: TAB_LABEL[tab] })
	await expect(trigger).toBeVisible()
	if ((await trigger.getAttribute('aria-selected')) !== 'true') await trigger.click()
	await expect(trigger).toHaveAttribute('aria-selected', 'true')
}
