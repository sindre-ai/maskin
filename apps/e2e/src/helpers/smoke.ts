import type { Page } from '@playwright/test'
import { TestAPI, loginTestActor } from './api.helper'
import { getSmokeConfig } from './smoke-env'
import { recordCreatedObject } from './smoke-ledger'

export type { SmokeConfig } from './smoke-env'
export { getSmokeConfig }

/** Authenticate as the smoke actor and return it alongside a ready TestAPI. */
export async function resolveSmokeAccount(config: {
	email: string
	password: string
	workspaceId: string
}) {
	const actor = await loginTestActor(config.email, config.password)
	return { actor, api: new TestAPI(actor.api_key) }
}

/**
 * Record objects the *browser* creates. Specs that drive the CreatePicker (e.g.
 * `objects-crud`) go through the app's own `POST /api/objects`, which never
 * touches `TestAPI`, so instrumenting the helper alone would miss them and leak
 * those rows into the smoke tenant.
 */
export function trackObjectsCreatedInBrowser(page: Page) {
	page.on('response', (response) => {
		const request = response.request()
		if (request.method() !== 'POST' || !response.ok()) return
		// Exactly the create endpoint — not `/api/objects/:id` sub-routes.
		const path = new URL(response.url()).pathname.replace(/\/$/, '')
		if (path !== '/api/objects') return

		response
			.json()
			.then((body: unknown) => {
				if (body && typeof body === 'object' && 'id' in body) {
					recordCreatedObject(String((body as { id: unknown }).id))
				}
			})
			.catch(() => {
				// Non-JSON or already-consumed body — nothing to record.
			})
	})
}
