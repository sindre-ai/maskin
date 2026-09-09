import { describe, expect, it } from 'vitest'
import {
	TRIGGER_KIND_INTEGRATIONS,
	getRequiredIntegrationsForPlan,
	getRequiredIntegrationsForPlanTrigger,
	normalizeTriggerKindLabel,
} from '../../loops/trigger-integrations'

describe('normalizeTriggerKindLabel', () => {
	it('maps RECURRING to cron', () => {
		expect(normalizeTriggerKindLabel('RECURRING')).toBe('cron')
	})

	it('maps CRON to cron', () => {
		expect(normalizeTriggerKindLabel('CRON')).toBe('cron')
	})

	it('maps REMINDER to reminder', () => {
		expect(normalizeTriggerKindLabel('REMINDER')).toBe('reminder')
	})

	it('defaults unknown or missing labels to event', () => {
		expect(normalizeTriggerKindLabel(undefined)).toBe('event')
		expect(normalizeTriggerKindLabel('')).toBe('event')
		expect(normalizeTriggerKindLabel('EVENT')).toBe('event')
		expect(normalizeTriggerKindLabel('NOTIFY')).toBe('event')
	})
})

describe('TRIGGER_KIND_INTEGRATIONS', () => {
	it('covers every known kind', () => {
		expect(Object.keys(TRIGGER_KIND_INTEGRATIONS).sort()).toEqual(['cron', 'event', 'reminder'])
	})
})

describe('getRequiredIntegrationsForPlanTrigger', () => {
	it('returns no providers for a bare recurring cadence', () => {
		expect(
			getRequiredIntegrationsForPlanTrigger({
				kindLabel: 'RECURRING',
				whenClause: 'when the weekly summary is due',
				targetAgent: 'Summary agent',
			}),
		).toEqual([])
	})

	it('detects slack from the whenClause', () => {
		expect(
			getRequiredIntegrationsForPlanTrigger({
				kindLabel: 'EVENT',
				whenClause: 'when someone posts in slack',
				targetAgent: 'Triage agent',
			}),
		).toEqual(['slack'])
	})

	it('detects hubspot via the pipeline synonym', () => {
		expect(
			getRequiredIntegrationsForPlanTrigger({
				kindLabel: 'EVENT',
				whenClause: 'when a pipeline stage changes',
			}),
		).toEqual(['hubspot'])
	})

	it('detects github from PR-adjacent phrasing', () => {
		expect(
			getRequiredIntegrationsForPlanTrigger({
				kindLabel: 'EVENT',
				whenClause: 'when a pull request lands',
			}),
		).toEqual(['github'])
	})

	it('deduplicates and covers keywords case-insensitively', () => {
		expect(
			getRequiredIntegrationsForPlanTrigger({
				kindLabel: 'EVENT',
				whenClause: 'When Slack messages arrive from a Slack channel',
			}),
		).toEqual(['slack'])
	})
})

describe('getRequiredIntegrationsForPlan', () => {
	it('deduplicates across triggers and preserves first-mention order', () => {
		const providers = getRequiredIntegrationsForPlan([
			{ kindLabel: 'EVENT', whenClause: 'when a github PR merges' },
			{ kindLabel: 'EVENT', whenClause: 'when a slack thread updates' },
			{ kindLabel: 'EVENT', whenClause: 'when github fires again' },
		])
		expect(providers).toEqual(['github', 'slack'])
	})

	it('is empty for a plan with no triggers', () => {
		expect(getRequiredIntegrationsForPlan([])).toEqual([])
	})
})
