import { describe, expect, it } from 'vitest'
import {
	type EventRow,
	PREDICT_WARN_THRESHOLD,
	type TriggerRow,
	arrayValuedEntries,
	buildFilterRoot,
	buildReports,
	countMatches,
	describeCause,
	formatDefault,
	formatFixRelight,
	formatJson,
	formatPredict,
	matchesFilterV1,
	parseArgs,
	passesEntityAndAction,
	relightPatch,
	renderReport,
} from '../../../scripts/trigger-lint'

/**
 * Snapshot suite for the `pnpm trigger:lint <workspace>` CLI. Locks in the
 * five acceptance-criteria paths (§AC of the S5 task) with fixed fixture
 * rows so a downstream config change is a visible red diff — this is the
 * only test coverage on the CLI, so drift here shows up in the snapshot
 * itself, not a nested behavioural assertion.
 *
 * The default and JSON renderers each get their own snapshot to keep JSON
 * diffs clean of the human-readable furniture. --fix-relight and --predict
 * snapshot their appended blocks separately so a change to one doesn't
 * churn the other.
 */

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000000'
const HEALTHY_TRIGGER_ID = '11111111-1111-4111-8111-111111111111'
const DEAD_ARRAY_TRIGGER_ID = '22222222-2222-4222-8222-222222222222'
const DEAD_DORMANT_TRIGGER_ID = '33333333-3333-4333-8333-333333333333'

const healthyTrigger: TriggerRow = {
	id: HEALTHY_TRIGGER_ID,
	name: 'Reminder to nudge Slack channel',
	type: 'event',
	enabled: true,
	config: {
		entity_type: 'objects',
		action: 'created',
		filter: { type: 'task' },
	},
}

const deadArrayTrigger: TriggerRow = {
	id: DEAD_ARRAY_TRIGGER_ID,
	name: 'Assign onboarding on stage change',
	type: 'event',
	enabled: true,
	config: {
		entity_type: 'objects',
		action: 'updated',
		filter: { status: ['onboarding', 'kickoff'] },
	},
}

const deadDormantTrigger: TriggerRow = {
	id: DEAD_DORMANT_TRIGGER_ID,
	name: 'Escalate on legal review',
	type: 'event',
	enabled: true,
	config: {
		entity_type: 'legal.review_requested',
		action: 'created',
	},
}

function objectCreatedEvent(type: string, id: string): EventRow {
	return {
		eventId: id,
		entityType: 'objects',
		action: 'created',
		data: { type, id: `obj-${id}` },
	}
}

function objectUpdatedEvent(status: string, id: string): EventRow {
	return {
		eventId: id,
		entityType: 'objects',
		action: 'updated',
		data: {
			updated: { status, id: `obj-${id}` },
		},
	}
}

const replay: EventRow[] = [
	// 3 healthy-trigger matches — `objects` + `created` + `type=task`
	objectCreatedEvent('task', '1001'),
	objectCreatedEvent('task', '1002'),
	objectCreatedEvent('task', '1003'),
	// 2 events that don't match healthy (type mismatch)
	objectCreatedEvent('bet', '1004'),
	objectCreatedEvent('insight', '1005'),
	// 4 events that WOULD match dead-array trigger under matcher v2 (status
	// in the allow list) but never fire under v1 (array-value semantics)
	objectUpdatedEvent('onboarding', '2001'),
	objectUpdatedEvent('kickoff', '2002'),
	objectUpdatedEvent('onboarding', '2003'),
	objectUpdatedEvent('kickoff', '2004'),
	// 1 updated event with a non-matching status — filtered out either matcher
	objectUpdatedEvent('archived', '2005'),
]

describe('parseArgs', () => {
	it('defaults --events to 500 and every mode flag to false', () => {
		expect(parseArgs([WORKSPACE_ID])).toEqual({
			workspace: WORKSPACE_ID,
			events: 500,
			json: false,
			fixRelight: false,
			predict: false,
			strict: false,
			help: false,
		})
	})

	it('accepts --events with space and equals form', () => {
		expect(parseArgs([WORKSPACE_ID, '--events', '250']).events).toBe(250)
		expect(parseArgs([WORKSPACE_ID, '--events=100']).events).toBe(100)
	})

	it('rejects --events with a non-integer / non-positive value', () => {
		expect(() => parseArgs([WORKSPACE_ID, '--events', 'abc'])).toThrow(/positive integer/)
		expect(() => parseArgs([WORKSPACE_ID, '--events', '0'])).toThrow(/positive integer/)
		expect(() => parseArgs([WORKSPACE_ID, '--events', '-5'])).toThrow(/positive integer/)
	})

	it('rejects unknown flags rather than silently ignoring a typo', () => {
		expect(() => parseArgs([WORKSPACE_ID, '--fix-relight-all'])).toThrow(/Unknown flag/)
	})

	it('sets every mode flag when passed', () => {
		const args = parseArgs([WORKSPACE_ID, '--json', '--fix-relight', '--predict', '--strict'])
		expect(args).toMatchObject({
			json: true,
			fixRelight: true,
			predict: true,
			strict: true,
		})
	})
})

describe('arrayValuedEntries', () => {
	it('picks out only entries whose value is an array', () => {
		expect(arrayValuedEntries({ status: ['onboarding'], type: 'task', priority: null })).toEqual([
			{ key: 'status', values: ['onboarding'] },
		])
	})
	it('returns an empty list for missing or non-object input', () => {
		expect(arrayValuedEntries(undefined)).toEqual([])
		expect(arrayValuedEntries(null)).toEqual([])
	})
})

describe('matchesFilterV1', () => {
	it('strict-equals a scalar filter value against the resolved path', () => {
		expect(matchesFilterV1({ status: 'onboarding' }, { status: 'onboarding' })).toBe(true)
		expect(matchesFilterV1({ status: 'onboarding' }, { status: 'archived' })).toBe(false)
	})
	it('returns false for an array-valued filter (the bet #8 shape)', () => {
		expect(matchesFilterV1({ status: ['onboarding'] }, { status: 'onboarding' })).toBe(false)
	})
})

describe('buildFilterRoot', () => {
	it('unwraps `data.updated` for updated / status_changed actions', () => {
		expect(
			buildFilterRoot({
				eventId: 'e1',
				entityType: 'objects',
				action: 'updated',
				data: { updated: { status: 'live' } },
			}),
		).toEqual({ status: 'live' })
	})
	it('returns raw data for other actions', () => {
		expect(
			buildFilterRoot({
				eventId: 'e2',
				entityType: 'objects',
				action: 'created',
				data: { type: 'task' },
			}),
		).toEqual({ type: 'task' })
	})
})

describe('passesEntityAndAction', () => {
	it('honours the slack.message catch-all', () => {
		const event: EventRow = {
			eventId: 'e',
			entityType: 'slack.channel_message',
			action: 'created',
			data: {},
		}
		expect(passesEntityAndAction({ entity_type: 'slack.message' }, event)).toBe(true)
		expect(passesEntityAndAction({ entity_type: 'slack.channel_message' }, event)).toBe(true)
		expect(passesEntityAndAction({ entity_type: 'objects' }, event)).toBe(false)
	})
})

describe('countMatches', () => {
	it('healthy trigger fires 3 times under both matcher bodies', () => {
		expect(countMatches(healthyTrigger, replay, false)).toBe(3)
		expect(countMatches(healthyTrigger, replay, true)).toBe(3)
	})
	it('dead-array trigger fires 0 under v1, 4 under v2', () => {
		expect(countMatches(deadArrayTrigger, replay, false)).toBe(0)
		expect(countMatches(deadArrayTrigger, replay, true)).toBe(4)
	})
	it('dead-dormant trigger fires 0 under both matchers (no source events)', () => {
		expect(countMatches(deadDormantTrigger, replay, false)).toBe(0)
		expect(countMatches(deadDormantTrigger, replay, true)).toBe(0)
	})
})

describe('describeCause', () => {
	it('names the array-valued filter entry verbatim per §2.3', () => {
		expect(describeCause(deadArrayTrigger, replay)).toBe(
			'filter value at "status" is an array. Matcher v1 (today) rejects array values silently. Enable flag "trigger_engine_v2" for this workspace, then this trigger will match on the next event.',
		)
	})
	it('reports dormant source-event shape when no matching entity_type events are seen', () => {
		expect(describeCause(deadDormantTrigger, replay)).toMatch(
			/no events with entity_type "legal\.review_requested" seen/,
		)
	})
})

describe('relightPatch', () => {
	it('moves array-valued filter entries into a conditions[] row with operator "in"', () => {
		expect(relightPatch(deadArrayTrigger)).toEqual({
			path: `PATCH /api/triggers/${DEAD_ARRAY_TRIGGER_ID}`,
			body: {
				config: {
					entity_type: 'objects',
					action: 'updated',
					conditions: [{ field: 'status', operator: 'in', value: ['onboarding', 'kickoff'] }],
				},
			},
		})
	})
	it('returns null when the DEAD trigger has no array-valued filter', () => {
		expect(relightPatch(deadDormantTrigger)).toBeNull()
	})
})

describe('buildReports — happy path (all healthy)', () => {
	it('every enabled trigger is HEALTHY', () => {
		const reports = buildReports([healthyTrigger], replay, { predict: false })
		expect(reports).toEqual([
			{
				trigger_id: HEALTHY_TRIGGER_ID,
				trigger_name: 'Reminder to nudge Slack channel',
				trigger_type: 'event',
				status: 'HEALTHY',
				matches_v1: 3,
				window: replay.length,
				config: healthyTrigger.config,
				cause: null,
				relight_patch: null,
				projected_fires_v2: null,
				projection_warning: false,
			},
		])
	})
})

describe('buildReports — dead-trigger path (array filter)', () => {
	it('flags the array-filter trigger DEAD with the §2.3 cause + a relight patch', () => {
		const [report] = buildReports([deadArrayTrigger], replay, { predict: false })
		expect(report?.status).toBe('DEAD')
		expect(report?.matches_v1).toBe(0)
		expect(report?.cause).toMatch(/filter value at "status" is an array/)
		expect(report?.relight_patch).not.toBeNull()
	})
})

describe('formatDefault — human-readable §2.3 report shape', () => {
	it('renders one DEAD block + one HEALTHY block, snapshot-locked', () => {
		const reports = buildReports([deadArrayTrigger, healthyTrigger], replay, {
			predict: false,
		})
		expect(formatDefault(reports)).toMatchInlineSnapshot(`
			"Trigger "Assign onboarding on stage change" (id: 22222222-2222-4222-8222-222222222222)
			  Status:   DEAD (0 matches across last 10 events)
			  Config:   {"entity_type":"objects","action":"updated","filter":{"status":["onboarding","kickoff"]}}
			  Cause:    filter value at "status" is an array. Matcher v1 (today) rejects array values silently. Enable flag "trigger_engine_v2" for this workspace, then this trigger will match on the next event.
			  Relight:  --fix-relight prints the PATCH body.

			Trigger "Reminder to nudge Slack channel" (id: 11111111-1111-4111-8111-111111111111)
			  Status:   HEALTHY (3 matches in last 10 events)
			"
		`)
	})

	it('renders a friendly line when no triggers are enabled', () => {
		expect(formatDefault([])).toBe('No enabled triggers in this workspace.\n')
	})
})

describe('formatJson — machine-readable shape', () => {
	it('emits one JSON object per line with every report field', () => {
		const reports = buildReports([deadArrayTrigger], replay, { predict: true })
		const rendered = formatJson(reports)
		expect(rendered.endsWith('\n')).toBe(true)
		const parsed = JSON.parse(rendered.trim())
		expect(parsed).toMatchObject({
			trigger_id: DEAD_ARRAY_TRIGGER_ID,
			status: 'DEAD',
			matches_v1: 0,
			projected_fires_v2: 4,
			projection_warning: false,
		})
	})
})

describe('formatFixRelight — PATCH body per DEAD-with-array-filter trigger', () => {
	it('snapshot-locks the copy-pasteable block', () => {
		const reports = buildReports([deadArrayTrigger], replay, { predict: false })
		expect(formatFixRelight(reports)).toMatchInlineSnapshot(`
			"
			--fix-relight (copy-pasteable, NOT sent):

			# Trigger "Assign onboarding on stage change" (id: 22222222-2222-4222-8222-222222222222)
			PATCH /api/triggers/22222222-2222-4222-8222-222222222222
			{
			  "config": {
			    "entity_type": "objects",
			    "action": "updated",
			    "conditions": [
			      {
			        "field": "status",
			        "operator": "in",
			        "value": [
			          "onboarding",
			          "kickoff"
			        ]
			      }
			    ]
			  }
			}
			"
		`)
	})

	it('reports "no candidates" when no DEAD trigger has an array filter', () => {
		const reports = buildReports([deadDormantTrigger], replay, { predict: false })
		expect(formatFixRelight(reports)).toMatch(/no DEAD triggers with array-valued filters/)
	})
})

describe('formatPredict — matcher v2 projection', () => {
	it('sorts currently-DEAD triggers by projected fires desc; WARN above threshold', () => {
		const spikyTrigger: TriggerRow = {
			id: '44444444-4444-4444-8444-444444444444',
			name: 'Spiky reactivation',
			type: 'event',
			enabled: true,
			config: {
				entity_type: 'objects',
				action: 'updated',
				filter: { status: ['onboarding', 'kickoff', 'archived'] },
			},
		}
		// Grow the replay to synthesise a > 100-fire projection for the spiky
		// trigger — mirrors the bet #8 reactivation shape (13 dormant triggers,
		// a chunky window, one trigger about to fire hundreds of times).
		const busyReplay: EventRow[] = []
		for (let i = 0; i < 60; i++) busyReplay.push(objectUpdatedEvent('onboarding', `x${i}`))
		for (let i = 0; i < 60; i++) busyReplay.push(objectUpdatedEvent('archived', `y${i}`))
		const reports = buildReports([deadArrayTrigger, spikyTrigger, deadDormantTrigger], busyReplay, {
			predict: true,
		})
		const spikyReport = reports.find((r) => r.trigger_id === spikyTrigger.id)
		expect(spikyReport?.projected_fires_v2).toBe(120)
		expect(spikyReport?.projection_warning).toBe(true)
		expect(PREDICT_WARN_THRESHOLD).toBe(100)
		expect(formatPredict(reports)).toMatchInlineSnapshot(`
			"
			--predict (matcher v2 projection over the same window):

			WARN  120 projected fires  →  "Spiky reactivation" (id: 44444444-4444-4444-8444-444444444444)
			      60 projected fires  →  "Assign onboarding on stage change" (id: 22222222-2222-4222-8222-222222222222)
			      0 projected fires  →  "Escalate on legal review" (id: 33333333-3333-4333-8333-333333333333)
			"
		`)
	})

	it('reports "no currently-DEAD triggers to project" when every trigger is HEALTHY', () => {
		const reports = buildReports([healthyTrigger], replay, { predict: true })
		expect(formatPredict(reports)).toMatch(/no currently-DEAD triggers to project/)
	})
})

describe('renderReport — combined mode assembly', () => {
	it('json + predict + fix-relight compose in a stable order', () => {
		const reports = buildReports([deadArrayTrigger], replay, { predict: true })
		const rendered = renderReport(reports, { json: true, fixRelight: true, predict: true })
		const lines = rendered.split('\n')
		expect(lines[0]?.startsWith('{')).toBe(true)
		expect(rendered).toMatch(/--predict \(matcher v2 projection over the same window\):/)
		expect(rendered).toMatch(/--fix-relight \(copy-pasteable, NOT sent\):/)
	})
})
