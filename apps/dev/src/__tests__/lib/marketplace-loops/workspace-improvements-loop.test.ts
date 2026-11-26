import { describe, expect, it } from 'vitest'
import { getSkillData, getTriggerData, getViewData } from '../../../lib/marketplace-loops/loop-data'
import { loopSettingsSchema } from '../../../lib/marketplace-loops/loop-settings'
import {
	WORKSPACE_IMPROVEMENTS_ACTOR_IDS,
	WORKSPACE_IMPROVEMENTS_LOOP,
	WORKSPACE_IMPROVEMENTS_ROLE_IDS,
	WORKSPACE_IMPROVEMENTS_SKILL_IDS,
	WORKSPACE_IMPROVEMENTS_TRIGGER_IDS,
	WORKSPACE_IMPROVEMENTS_VIEW_IDS,
} from '../../../lib/marketplace-loops/workspace-improvements-loop'

const TRIGGERS = WORKSPACE_IMPROVEMENTS_TRIGGER_IDS.map(getTriggerData)
const SKILLS = WORKSPACE_IMPROVEMENTS_SKILL_IDS.map(getSkillData)
const sweep = TRIGGERS.find((t) => t.name.startsWith('Coach sweep'))
const heartbeat = TRIGGERS.find((t) => t.name.startsWith('Owner heartbeat'))

const TRIGGER_TEXTS = TRIGGERS.map((t) => `${t.name} ${t.actionPrompt ?? ''}`)
const SKILL_TEXTS = SKILLS.map((s) => `${s.name} ${s.description ?? ''} ${s.content ?? ''}`)
const VIEW_TEXTS = WORKSPACE_IMPROVEMENTS_VIEW_IDS.map((id) => getViewData(id).html)
const checklist = WORKSPACE_IMPROVEMENTS_LOOP.settings.checklist
const READABLE_TEXTS = [
	WORKSPACE_IMPROVEMENTS_LOOP.description,
	WORKSPACE_IMPROVEMENTS_LOOP.settings.entryCondition,
	WORKSPACE_IMPROVEMENTS_LOOP.settings.closeCondition,
	checklist?.title,
	checklist?.body,
	...(checklist?.items ?? []).map((i) => `${i.title} ${i.body}`),
	...(WORKSPACE_IMPROVEMENTS_LOOP.settings.targets ?? []).map((t) => `${t.label} ${t.source}`),
	...TRIGGER_TEXTS,
	...SKILL_TEXTS,
]

describe('Workspace improvements flow definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(WORKSPACE_IMPROVEMENTS_LOOP.slug).toBe('workspace-improvements-loop')
		expect(WORKSPACE_IMPROVEMENTS_LOOP.name).toBe('Workspace improvements')
		expect(WORKSPACE_IMPROVEMENTS_LOOP.version).toBe('1.0.0')
		expect(WORKSPACE_IMPROVEMENTS_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships no agent: triggers and skills name the Coach and the Chief of Staff by role', () => {
		expect(WORKSPACE_IMPROVEMENTS_ACTOR_IDS).toEqual([])
		expect([...WORKSPACE_IMPROVEMENTS_ROLE_IDS]).toEqual([
			'role:workspace-coach',
			'role:chief-of-staff',
		])
		const roles = new Set<string>(WORKSPACE_IMPROVEMENTS_ROLE_IDS)
		for (const t of TRIGGERS) expect(roles.has(t.targetActorId)).toBe(true)
		for (const s of SKILLS) {
			expect(s.attachedActorIds.length).toBeGreaterThan(0)
			for (const id of s.attachedActorIds) expect(roles.has(id)).toBe(true)
		}
		expect(WORKSPACE_IMPROVEMENTS_LOOP.settings.checklist?.driverSourceItemId).toBe(
			'role:chief-of-staff',
		)
	})

	it('ships the Coach sweep and the owner heartbeat, and not the Capture outcome trigger', () => {
		expect(TRIGGERS.map((t) => [t.name, t.type, t.config, t.targetActorId, t.enabled])).toEqual([
			[
				'Coach sweep (Mon, Wed, Fri 23:15 UTC)',
				'cron',
				{ expression: '15 23 * * 1,3,5' },
				'role:workspace-coach',
				true,
			],
			[
				'Owner heartbeat (daily 08:10 UTC)',
				'cron',
				{ expression: '10 8 * * *' },
				'role:chief-of-staff',
				true,
			],
		])
		for (const text of TRIGGER_TEXTS) expect(text).not.toMatch(/Capture outcome/)
	})

	it('folds the clustering and outcome steps into the sweep', () => {
		expect(sweep?.actionPrompt).toMatch(/Clustering step/)
		expect(sweep?.actionPrompt).toMatch(/Outcome capture step/)
	})

	it('ships the conditions and the two targets the heartbeat recounts, with no owner', () => {
		const settings = loopSettingsSchema.parse(WORKSPACE_IMPROVEMENTS_LOOP.settings)
		expect(settings.adoptExisting).toBe(true)
		expect(settings.entryCondition).toMatch(/\[workspace-improvements\]/)
		expect(settings.closeCondition).toMatch(/scored, parked, or discarded/)
		expect(settings.targets?.map((t) => t.label)).toEqual(['Insight backlog', 'Orphaned insights'])
		for (const target of settings.targets ?? []) {
			expect(heartbeat?.actionPrompt).toContain(target.label)
			expect(target).not.toHaveProperty('ownerActorId')
		}
	})

	it('starts the heartbeat with the onboarding checklist and its three-question limit', () => {
		expect(heartbeat?.actionPrompt).toMatch(/^First read the flow's onboarding checklist/)
		expect(heartbeat?.actionPrompt).toContain('Workspace improvements onboarding checklist')
		expect(heartbeat?.actionPrompt).toContain('at most 3 questions at a time')
		const settings = loopSettingsSchema.parse(WORKSPACE_IMPROVEMENTS_LOOP.settings)
		expect(settings.checklist?.items.length).toBeGreaterThan(0)
		const titles = (settings.checklist?.items ?? []).map((i) => i.title)
		expect(new Set(titles).size).toBe(titles.length)
	})

	it('lets the heartbeat skip the checklist step when the flow has none (an adopted flow)', () => {
		expect(heartbeat?.actionPrompt).toContain(
			'If there is no task named Workspace improvements onboarding checklist, skip this step and carry on.',
		)
	})

	it('ships the two skills the heartbeat loads, one tab, and no duplicates', () => {
		expect(SKILLS.map((s) => s.name)).toEqual(['drive-to-outcome', 'results-view-refresh'])
		expect(heartbeat?.actionPrompt).toContain('drive-to-outcome')
		expect(heartbeat?.actionPrompt).toContain('results-view-refresh')
		expect(WORKSPACE_IMPROVEMENTS_VIEW_IDS.length).toBe(1)
		expect(new Set(WORKSPACE_IMPROVEMENTS_TRIGGER_IDS).size).toBe(TRIGGERS.length)
	})

	it('looks the flow up by name and never by id', () => {
		for (const t of TRIGGERS) {
			expect(t.actionPrompt).toContain('Workspace improvements')
			expect(t.actionPrompt).toContain('list_loops')
		}
	})

	it('keeps the published text free of workspace-specific references and credentials', () => {
		for (const text of [...READABLE_TEXTS, ...VIEW_TEXTS]) {
			// ids, links, dates and years
			expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
			expect(text).not.toMatch(/https?:\/\/[^"\s]*maskin\.io|maskin\.io/i)
			expect(text).not.toMatch(
				/\b20\d\d\b|\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/,
			)
			expect(text).not.toMatch(/—|assum/i)
			// people, company, product and role titles from the source workspace
			expect(text).not.toMatch(
				/Sebastian|Sebk|Magnus|Netwerk|Maskin\b|Værksted|Krumhausen|Nøddegaard|Slack|\bCPO\b|\bCCO\b|\bCTO\b|Content Lead|Customer Success|Product Validator|Product Insights Analyst|Infra & DevOps|Knowledge Wiki|Knowledge Curator/,
			)
			// the live flow's dated item and its chat and file ids
			expect(text).not.toMatch(/Dated item|chat [0-9a-f]{8}|view-workspace-improvements/)
		}
	})

	it('says flow, not loop, in the text a person reads', () => {
		for (const text of READABLE_TEXTS) expect(text).not.toMatch(/\b[Ll]oops?\b/)
	})

	it('ships the Results tab as an empty starter page that scopes to the flow by token', () => {
		const views = WORKSPACE_IMPROVEMENTS_VIEW_IDS.map(getViewData)
		expect(views.map((v) => [v.name, v.position])).toEqual([['Results', 0]])
		const html = views[0]?.html ?? ''
		const data = /<script id="results-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
			html,
		)?.[1]
		const parsed = JSON.parse(data ?? 'null') as { items: unknown[]; monitor: unknown[] }
		expect(parsed.items).toEqual([])
		expect(parsed.monitor).toEqual([])
		expect(html).toContain('__MASKIN_LOOP_ID__')
		expect(html).toContain('maskin.query')
	})
})
