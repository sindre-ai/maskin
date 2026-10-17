// Sends a LegacyCase and reduces the answer to the comparable shape that the
// recorded fixtures use. Shared by the recorder and by the replay row, so the
// two can never normalise differently.

import type { LegacyCase, RecordedResponse } from './legacy-cases'
import type { Target } from './types'
import { bare, post } from './wire'

const WORKSPACE_PLACEHOLDER = '{{WORKSPACE_ID}}'

export async function runLegacyCase(target: Target, c: LegacyCase): Promise<RecordedResponse> {
	const options = { noAuth: c.noAuth }
	const observed =
		c.method === 'POST'
			? await post(target, c.body, options)
			: await bare(target, c.method, options)
	const text = observed.text.split(target.workspaceId).join(WORKSPACE_PLACEHOLDER)
	let body: unknown = text
	try {
		body = text ? JSON.parse(text) : ''
	} catch {
		// Not JSON (405 and 202 answer plain text): keep the raw text.
	}
	return {
		status: observed.status,
		contentType: observed.contentType ? observed.contentType.toLowerCase() : null,
		body,
	}
}
