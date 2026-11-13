import { FEATURE_AREAS } from '@maskin/shared'

/**
 * What the iPhone app may send through `POST /api/telemetry/client`: the event names and, per
 * event, the property keys and the shape of each value. Anything else is refused, so a name, a
 * message or a search query cannot ride along. Names and keys match the web events and the
 * "Product tracking plan"; the base fields (workspace_id, actor_id, actor_type, surface,
 * feature_area) are set by the server and are not allowed from the client.
 */

// An id or slug: no spaces, so a sentence does not fit.
const ID = /^[A-Za-z0-9_-]{1,64}$/
// A short label such as a screen name ("For you"). Words only, no sentences.
const LABEL = /^[A-Za-z0-9 _.:-]{1,40}$/

type ValueRule = 'id' | 'label' | 'int' | readonly string[]

const CARD_KIND = ['decision', 'thread'] as const

const EVENT_PROPERTIES: Record<string, Record<string, ValueRule>> = {
	app_installed: {},
	first_sign_in: {},
	app_opened: {},
	app_active: { utc_day: 'id' },
	screen_viewed: { screen: 'label', feature_area: FEATURE_AREAS },
	push_permission_granted: {},
	push_permission_denied: {},
	push_notification_opened: { notification_id: 'id', type: 'id' },
	foryou_card_shown: { card_kind: CARD_KIND, card_id: 'id' },
	foryou_card_action: { card_kind: CARD_KIND, card_id: 'id', action_id: 'id' },
	chat_session_started: {
		entity_id: 'id',
		entity_type: ['session'],
		source: ['iphone'],
		entry_point: 'id',
		participant_count: 'int',
		entry_agent_role: 'id',
	},
	object_created: {
		entity_id: 'id',
		entity_type: ['object'],
		source: ['iphone'],
		object_subtype: 'id',
	},
	object_updated: {
		object_id: 'id',
		mutation_type: 'id',
		via: ['single', 'bulk'],
		bulk_batch_size: 'int',
	},
	object_viewed: { entity_id: 'id', entity_type: ['object'], object_type: 'id' },
	// The two generic step events from the plan, for flows with no screen of their own.
	flow_step: { flow: 'id', step: 'id', flow_id: 'id', duration_ms: 'int' },
	flow_error: { flow: 'id', step: 'id', error_category: 'id' },
}

// Keys that usually hold a person's words or identity. Told apart from "unknown key" so the
// 400 says why the key can never be added to the list by accident.
const FREE_TEXT_KEY =
	/(^|_)(name|email|title|text|content|message|body|summary|description|subject|query|label|note|phone|comment|prompt|address|error|reason)(_|$)/i

export interface ClientEventProblem {
	/** Where in the request, for example `events[2].properties.query`. */
	path: string
	message: string
}

function valueProblem(rule: ValueRule, value: string | number | boolean): string | null {
	if (rule === 'int') {
		return typeof value === 'number' && Number.isInteger(value) && value >= 0
			? null
			: 'must be a whole number, zero or more'
	}
	if (typeof value !== 'string') return 'must be a string'
	if (rule === 'id')
		return ID.test(value) ? null : 'must be an id or slug (letters, digits, _ or -)'
	if (rule === 'label') return LABEL.test(value) ? null : 'must be a short label'
	return rule.includes(value) ? null : `must be one of ${rule.join(', ')}`
}

/** The first thing wrong with one event, or null. `index` is its place in the batch. */
export function checkClientEvent(
	index: number,
	name: string,
	properties: Record<string, string | number | boolean>,
): ClientEventProblem | null {
	const allowed = EVENT_PROPERTIES[name]
	if (!allowed) {
		return { path: `events[${index}].name`, message: `Event name "${name}" is not allowed` }
	}
	for (const [key, value] of Object.entries(properties)) {
		const path = `events[${index}].properties.${key}`
		const rule = allowed[key]
		if (rule === undefined) {
			return {
				path,
				message: FREE_TEXT_KEY.test(key)
					? `Property "${key}" looks like free text and is never accepted`
					: `Property "${key}" is not allowed on "${name}"`,
			}
		}
		const problem = valueProblem(rule, value)
		if (problem) return { path, message: `Property "${key}" ${problem}` }
	}
	return null
}
