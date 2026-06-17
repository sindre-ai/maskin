// Canonical metadata for the four cross-functional job-loop catalog packages
// shipped by bet/curated-catalog-content (Bug triage, Launch, Standup,
// Incident). Names, descriptions, and item composition here are PLACEHOLDERS —
// T1 (Architect) picks the curated item composition and T2 (Product Marketer)
// picks the customer-facing names and copy. Once those land, swap the values
// in this file; the rest of the seed wiring stays the same.
//
// Categorisation: every loop in this set is tagged with `JOB_LOOP_CATEGORY` so
// the storefront tab on /marketplace (T4) can filter the Stack tab to only
// these packages, separately from the existing Customer Continuous Discovery
// package (`discovery`).

export const JOB_LOOP_CATEGORY = 'job-loop'
export const DISCOVERY_CATEGORY = 'discovery'

export const JOB_LOOP_PACKAGE_VERSION = '0.1.0'

// Each item ships with a stable hardcoded UUID for `source_item_id` so reseeds
// stay deterministic. These are placeholder integration items pulled from the
// six providers the bet's First Test names (GitHub, Linear, PostHog, Sentry,
// Notion, Slack) — only Slack/GitHub/Linear/PostHog have provider configs in
// `apps/dev/src/lib/integrations/providers/` today, so the placeholders pick
// from that set. T1 will replace the composition with its curated picks.

export type JobLoopPackageItem = {
	sourceItemId: string
	itemType: 'actor' | 'trigger' | 'skill' | 'integration'
	itemSnapshot: {
		provider: string
		name: string
		description: string
	}
}

export type JobLoopPackage = {
	slug: string
	name: string
	description: string
	useCase: string
	items: JobLoopPackageItem[]
}

export const JOB_LOOP_PACKAGES: readonly JobLoopPackage[] = [
	{
		slug: 'bug-triage',
		name: 'Bug triage',
		description:
			'Catch new bug reports, route them to the right owner, and close the loop with the customer once the fix ships. Placeholder copy — T2 owns the final wording.',
		useCase: 'Bug triage',
		items: [
			{
				sourceItemId: 'a1f1b001-0001-4001-8001-000000000001',
				itemType: 'integration',
				itemSnapshot: {
					provider: 'github',
					name: 'GitHub',
					description: 'Pull bug reports from issues and watch fix PRs land.',
				},
			},
			{
				sourceItemId: 'a1f1b001-0001-4001-8001-000000000002',
				itemType: 'integration',
				itemSnapshot: {
					provider: 'linear',
					name: 'Linear',
					description: 'Route triaged bugs to the owning team in Linear.',
				},
			},
			{
				sourceItemId: 'a1f1b001-0001-4001-8001-000000000003',
				itemType: 'integration',
				itemSnapshot: {
					provider: 'slack',
					name: 'Slack',
					description: 'Reply in-channel when the customer-reported fix ships.',
				},
			},
		],
	},
	{
		slug: 'launch',
		name: 'Launch',
		description:
			'Coordinate a feature launch — ship checklist, analytics setup, and a roll-out announcement. Placeholder copy — T2 owns the final wording.',
		useCase: 'Launch',
		items: [
			{
				sourceItemId: 'a1f1b001-0002-4001-8001-000000000001',
				itemType: 'integration',
				itemSnapshot: {
					provider: 'linear',
					name: 'Linear',
					description: 'Track launch tasks against the launch milestone.',
				},
			},
			{
				sourceItemId: 'a1f1b001-0002-4001-8001-000000000002',
				itemType: 'integration',
				itemSnapshot: {
					provider: 'posthog',
					name: 'PostHog',
					description: 'Watch the activation funnel against the new surface.',
				},
			},
			{
				sourceItemId: 'a1f1b001-0002-4001-8001-000000000003',
				itemType: 'integration',
				itemSnapshot: {
					provider: 'slack',
					name: 'Slack',
					description: 'Post the launch announcement and gather first reactions.',
				},
			},
		],
	},
	{
		slug: 'standup',
		name: 'Standup',
		description:
			'Daily team async: yesterday/today/blocked summary built from the work tools the team already uses. Placeholder copy — T2 owns the final wording.',
		useCase: 'Standup',
		items: [
			{
				sourceItemId: 'a1f1b001-0003-4001-8001-000000000001',
				itemType: 'integration',
				itemSnapshot: {
					provider: 'linear',
					name: 'Linear',
					description: 'Pull in-flight issues per team member for the digest.',
				},
			},
			{
				sourceItemId: 'a1f1b001-0003-4001-8001-000000000002',
				itemType: 'integration',
				itemSnapshot: {
					provider: 'github',
					name: 'GitHub',
					description: 'Surface open PRs and review backlog in the digest.',
				},
			},
			{
				sourceItemId: 'a1f1b001-0003-4001-8001-000000000003',
				itemType: 'integration',
				itemSnapshot: {
					provider: 'slack',
					name: 'Slack',
					description: 'Post the standup digest into the team channel each morning.',
				},
			},
		],
	},
	{
		slug: 'incident',
		name: 'Incident',
		description:
			'Open and steer a customer-facing incident: detection, communication, and post-incident review. Placeholder copy — T2 owns the final wording.',
		useCase: 'Incident',
		items: [
			{
				sourceItemId: 'a1f1b001-0004-4001-8001-000000000001',
				itemType: 'integration',
				itemSnapshot: {
					provider: 'slack',
					name: 'Slack',
					description: 'Stand up the incident channel and coordinate responders.',
				},
			},
			{
				sourceItemId: 'a1f1b001-0004-4001-8001-000000000002',
				itemType: 'integration',
				itemSnapshot: {
					provider: 'posthog',
					name: 'PostHog',
					description: 'Quantify the affected surface from product analytics.',
				},
			},
			{
				sourceItemId: 'a1f1b001-0004-4001-8001-000000000003',
				itemType: 'integration',
				itemSnapshot: {
					provider: 'github',
					name: 'GitHub',
					description: 'Track the mitigating PR and post-incident issue.',
				},
			},
		],
	},
] as const
