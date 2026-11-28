import { describe, expect, it } from 'vitest'
import { getActorData, getSkillData } from '../../../lib/marketplace-loops/loop-data'
import { loopSettingsSchema } from '../../../lib/marketplace-loops/loop-settings'
import {
	PRESENTATION_DESIGNER_ACTOR_IDS,
	PRESENTATION_DESIGNER_LOOP,
	PRESENTATION_DESIGNER_SKILL_IDS,
	PRESENTATION_DESIGNER_TRIGGER_IDS,
} from '../../../lib/marketplace-loops/presentation-designer-loop'

const SKILL_NAMES = [
	'coding-discipline',
	'frontend-design',
	'presentation-html-patterns',
	'presentation-narrative-craft',
	'upload-binary-file',
	'viewer-safe-html',
	'visual-design-patterns',
]

function publishedTexts() {
	return [
		`${PRESENTATION_DESIGNER_LOOP.name} ${PRESENTATION_DESIGNER_LOOP.description}`,
		PRESENTATION_DESIGNER_LOOP.settings.agentOnly ? 'agentOnly' : '',
		PRESENTATION_DESIGNER_LOOP.settings.firstLook ?? '',
		...PRESENTATION_DESIGNER_ACTOR_IDS.map((id) => {
			const a = getActorData(id)
			return `${a.name} ${a.description} ${a.systemPrompt}`
		}),
		...PRESENTATION_DESIGNER_SKILL_IDS.map((id) => {
			const s = getSkillData(id)
			return `${s.name} ${s.description} ${s.content}`
		}),
	]
}

describe('Presentation Designer listing definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(PRESENTATION_DESIGNER_LOOP.slug).toBe('presentation-designer')
		expect(PRESENTATION_DESIGNER_LOOP.name).toBe('Presentation Designer')
		expect(PRESENTATION_DESIGNER_LOOP.useCase).toBe('Marketing')
		expect(PRESENTATION_DESIGNER_LOOP.version).toBe('1.0.0')
		expect(PRESENTATION_DESIGNER_LOOP.description.length).toBeGreaterThan(0)
	})

	it('is marked agent-only, with a first look that searches knowledge pages, files and brand notes', () => {
		const settings = loopSettingsSchema.parse(PRESENTATION_DESIGNER_LOOP.settings)
		expect(settings.agentOnly).toBe(true)
		expect(settings.firstLook).toMatch(/knowledge pages/)
		expect(settings.firstLook).toMatch(/files/)
		expect(settings.firstLook).toMatch(/brand notes/)
		expect(settings.firstLook).toMatch(/Design style/)
		// No flow page ships, so there is nothing for flow-page settings to sit on.
		expect(settings.entryCondition).toBeUndefined()
		expect(settings.closeCondition).toBeUndefined()
		expect(settings.targets).toBeUndefined()
		expect(settings.checklist).toBeUndefined()
	})

	it('ships one agent, no triggers and the seven skills the task names, with no duplicates', () => {
		expect(PRESENTATION_DESIGNER_ACTOR_IDS.length).toBe(1)
		expect(PRESENTATION_DESIGNER_TRIGGER_IDS.length).toBe(0)
		expect(PRESENTATION_DESIGNER_SKILL_IDS.length).toBe(7)
		expect(new Set(PRESENTATION_DESIGNER_SKILL_IDS).size).toBe(7)
		expect(PRESENTATION_DESIGNER_SKILL_IDS.map((id) => getSkillData(id).name).sort()).toEqual(
			SKILL_NAMES,
		)
	})

	it('attaches every skill to the one shipped agent', () => {
		const actorIds = new Set<string>(PRESENTATION_DESIGNER_ACTOR_IDS)
		for (const id of PRESENTATION_DESIGNER_SKILL_IDS) {
			const { attachedActorIds } = getSkillData(id)
			expect(attachedActorIds).toEqual([...actorIds])
		}
	})

	it('has a prompt that covers decks only, two canvases, the density question and the story check', () => {
		const prompt = getActorData(PRESENTATION_DESIGNER_ACTOR_IDS[0] as string).systemPrompt ?? ''
		expect(prompt).toMatch(/Decks and the slide visuals inside them/)
		expect(prompt).toMatch(
			/do not make standalone covers, thumbnails, event material, briefing decks or infographics/i,
		)
		expect(prompt).toMatch(/two fixed canvases/)
		expect(prompt).toMatch(/1920 by 1080/)
		expect(prompt).toMatch(/720 by 1280/)
		expect(prompt).toMatch(/density question/i)
		expect(prompt).toMatch(/Story before design/)
		expect(prompt).toMatch(/throughline/i)
	})

	it('tells the agent to check each screen size and mark it checked or not visually checked', () => {
		const prompt = getActorData(PRESENTATION_DESIGNER_ACTOR_IDS[0] as string).systemPrompt ?? ''
		expect(prompt).toMatch(/1920 wide/)
		expect(prompt).toMatch(/390 by 844/)
		expect(prompt).toMatch(/not visually checked/)
		expect(prompt).toMatch(/Never mark a size checked unless you looked at it/)
	})

	it('saves a style the person gives it as a Design style page, and carries a two-line voice rule', () => {
		const prompt = getActorData(PRESENTATION_DESIGNER_ACTOR_IDS[0] as string).systemPrompt ?? ''
		expect(prompt).toMatch(/knowledge object titled exactly "Design style"/)
		expect(prompt).toMatch(/# Voice\n[^\n]+\n[^\n]+/)
		expect(prompt).toMatch(/short sentences, contractions, no long dashes and no jargon/)
	})

	it('names every shipped skill in the prompt, so the agent can load it', () => {
		const prompt = getActorData(PRESENTATION_DESIGNER_ACTOR_IDS[0] as string).systemPrompt ?? ''
		for (const name of SKILL_NAMES) expect(prompt).toContain(name)
	})

	it('keeps tool access free of connected servers', () => {
		for (const id of PRESENTATION_DESIGNER_ACTOR_IDS) {
			expect(JSON.stringify(getActorData(id).tools)).not.toContain('mcpServers')
		}
	})

	it('keeps the published text free of workspace-specific names, ids, dates and links', () => {
		const text = JSON.stringify(publishedTexts()).replaceAll('http://www.w3.org/2000/svg', '')
		const forbidden = [
			/maskin|vaerksted|sindre|skjald|meshfirm/i,
			/sebastian|sebk|magnus|krumhausen/i,
			/presentation studio|visual designer|design studio/i,
			/\b20\d\d\b/,
			/\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/,
			/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}\b/,
			/@[a-z0-9-]+\.(io|com|dk)\b/i,
		]
		for (const pattern of forbidden) expect(text).not.toMatch(pattern)

		const ownIds = new Set<string>([
			...PRESENTATION_DESIGNER_ACTOR_IDS,
			...PRESENTATION_DESIGNER_SKILL_IDS,
		])
		const foundIds =
			text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []
		for (const id of foundIds) expect(ownIds.has(id)).toBe(true)
	})

	it('says flow and deck, not loop, in the text a person reads', () => {
		for (const text of publishedTexts()) expect(text).not.toMatch(/\b[Ll]oops?\b/)
	})
})
