import type { Locator, Page } from '@playwright/test'
import { DEMO_WORKSPACE_ID } from './config'

/** What a shot may need to find on the page; looked up from the demo workspace at run time. */
export interface ShotContext {
	betId: string
	conversationId: string
}

export interface Shot {
	/** The name used to ask for the shot, and in the file name. */
	name: string
	/** Where to go, as a path inside the demo workspace. */
	path: (ctx: ShotContext) => string
	/** Waits until the screen has what the shot is about. */
	ready: (page: Page) => Promise<void>
	/** Capture just this element instead of the whole viewport. */
	target?: (page: Page) => Locator
}

const workspacePath = (rest: string) => `/${DEMO_WORKSPACE_ID}${rest}`

// Adding a shot is adding one entry here.
export const SHOTS: Shot[] = [
	{
		name: 'approval-card',
		path: () => workspacePath(''),
		ready: async (page) => {
			await page.getByTestId('foryou-feed-card').first().waitFor()
		},
		target: (page) => page.getByTestId('foryou-feed-card').first(),
	},
	{
		name: 'for-you',
		path: () => workspacePath(''),
		ready: async (page) => {
			await page.getByTestId('foryou-feed-card').first().waitFor()
		},
	},
	{
		name: 'task-board',
		path: () => workspacePath('/objects?type=task'),
		ready: async (page) => {
			// The board is a display choice of the list, switched through the Display menu.
			await page.getByRole('button', { name: /display/i }).click()
			await page.getByRole('button', { name: 'Board', exact: true }).click()
			await page.keyboard.press('Escape')
			await page.getByTestId('board-view').waitFor()
		},
	},
	{
		name: 'chat',
		path: (ctx) => workspacePath(`/chats/${ctx.conversationId}`),
		ready: async (page) => {
			await page.getByText('Morning! Two things need you today').waitFor()
		},
	},
	{
		name: 'bet',
		path: (ctx) => workspacePath(`/objects/${ctx.betId}`),
		ready: async (page) => {
			await page.getByText('Open click-and-collect at Bageriet Nordlys').first().waitFor()
		},
	},
]

export function findShot(name: string): Shot {
	const shot = SHOTS.find((s) => s.name === name)
	if (!shot) {
		throw new Error(`Unknown shot "${name}". Available: ${SHOTS.map((s) => s.name).join(', ')}`)
	}
	return shot
}
