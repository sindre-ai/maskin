import { describe, expect, it } from 'vitest'
import {
	VOICE_CALL_CONDUCT,
	VOICE_DECISION_RULE,
	VOICE_DRAFT_RULE,
	VOICE_FOR_YOU_RULE,
	VOICE_LANGUAGE_RULE,
	VOICE_SKILLS_TOTAL_MAX_CHARS,
	VOICE_WRITE_CONFIRMATION,
	buildVoiceInstructions,
	capVoiceSkills,
	formatVoiceCallerContext,
} from '../../services/voice-instructions'

const NOW = new Date('2026-10-25T23:30:00Z')

describe('formatVoiceCallerContext', () => {
	it("names the caller and gives the date and time in the caller's time zone", () => {
		const out = formatVoiceCallerContext({
			callerName: 'Sam',
			timezone: 'Europe/Copenhagen',
			now: NOW,
		})
		expect(out).toContain('You are speaking with Sam.')
		// 23:30 UTC on 25 Oct is 00:30 on 26 Oct in Copenhagen (clocks went back that night).
		expect(out).toContain('Monday 26 October 2026, 00:30 (Europe/Copenhagen)')
	})

	it('falls back to UTC when no time zone is stored', () => {
		const out = formatVoiceCallerContext({ callerName: 'Sam', timezone: null, now: NOW })
		expect(out).toContain('Sunday 25 October 2026, 23:30 UTC')
	})

	it('falls back to UTC when the stored time zone is not valid', () => {
		const out = formatVoiceCallerContext({ callerName: 'Sam', timezone: 'Mars/Olympus', now: NOW })
		expect(out).toContain('Sunday 25 October 2026, 23:30 UTC')
		expect(out).not.toContain('Mars/Olympus')
	})

	it('leaves the name out when it is unknown', () => {
		const out = formatVoiceCallerContext({ callerName: ' ', timezone: null, now: NOW })
		expect(out).not.toContain('speaking with')
		expect(out).toContain('It is now')
	})
})

describe('capVoiceSkills', () => {
	const ctx = { voiceSessionId: 'vs-1' }

	it('keeps every skill when they fit', () => {
		const skills = [
			{ name: 'a', content: 'x'.repeat(100) },
			{ name: 'b', content: 'y'.repeat(100) },
		]
		expect(capVoiceSkills(skills, ctx)).toEqual(skills)
	})

	it('drops the longest skills first until the total fits, keeping the order of the rest', () => {
		const half = Math.floor(VOICE_SKILLS_TOTAL_MAX_CHARS / 2)
		const skills = [
			{ name: 'small', content: 'x'.repeat(500) },
			{ name: 'huge', content: 'y'.repeat(VOICE_SKILLS_TOTAL_MAX_CHARS) },
			{ name: 'medium', content: 'z'.repeat(half) },
		]
		const kept = capVoiceSkills(skills, ctx)
		expect(kept.map((s) => s.name)).toEqual(['small', 'medium'])
		expect(kept.reduce((n, s) => n + s.content.length, 0)).toBeLessThanOrEqual(
			VOICE_SKILLS_TOTAL_MAX_CHARS,
		)
	})

	it('never returns more than the cap when many skills each fit alone', () => {
		const skills = Array.from({ length: 20 }, (_, i) => ({
			name: `s${i}`,
			content: 'x'.repeat(3000 + i),
		}))
		const kept = capVoiceSkills(skills, ctx)
		expect(kept.length).toBeLessThan(skills.length)
		expect(kept.reduce((n, s) => n + s.content.length, 0)).toBeLessThanOrEqual(
			VOICE_SKILLS_TOTAL_MAX_CHARS,
		)
	})
})

describe('VOICE_CALL_CONDUCT connections rule', () => {
	it('routes "is X connected" to list_integrations with provider, not a long list', () => {
		expect(VOICE_CALL_CONDUCT).toContain('list_integrations with provider set to its name')
		expect(VOICE_CALL_CONDUCT).toContain('Never ask for a long list')
	})

	it('says an incomplete list is not proof that something is missing', () => {
		expect(VOICE_CALL_CONDUCT).toContain('voice_truncated')
		expect(VOICE_CALL_CONDUCT).toContain('page.has_more')
		expect(VOICE_CALL_CONDUCT).toContain('never that the thing is not connected')
	})
})

describe('buildVoiceInstructions', () => {
	const base = {
		systemPrompt: 'You are the agent.',
		workspaceId: 'ws-1',
		voiceSessionId: 'vs-1',
		caller: { id: 'actor-1', name: 'Sam Caller', timezone: null },
		skills: [],
		chatHistory: '',
		now: NOW,
	}

	it('names the caller, gives their id and tells the agent not to ask who they are', () => {
		const text = buildVoiceInstructions(base)
		expect(text).toContain('You are speaking with Sam Caller.')
		expect(text).toContain('actor-1')
		expect(text).toContain('never ask who they are')
	})

	it('gives every agent the call conduct rules, with or without a system prompt', () => {
		expect(buildVoiceInstructions(base)).toContain(VOICE_CALL_CONDUCT)
		expect(buildVoiceInstructions({ ...base, systemPrompt: null })).toContain(VOICE_CALL_CONDUCT)
	})

	it('tells every agent to answer in the language the person speaks, in natural spoken Danish', () => {
		for (const systemPrompt of ['You are the agent.', null]) {
			expect(buildVoiceInstructions({ ...base, systemPrompt })).toContain(VOICE_LANGUAGE_RULE)
		}
		expect(VOICE_LANGUAGE_RULE).toContain('language the person is speaking')
		expect(VOICE_LANGUAGE_RULE).toContain('natural spoken Danish')
		expect(VOICE_LANGUAGE_RULE).toContain('pronounce Danish')
	})

	it('tells the agent to read what needs the caller from list_for_you, top card first', () => {
		const text = buildVoiceInstructions(base)
		expect(text).toContain(VOICE_FOR_YOU_RULE)
		expect(VOICE_FOR_YOU_RULE).toContain('list_for_you')
		expect(VOICE_FOR_YOU_RULE).toContain('top card')
		expect(VOICE_FOR_YOU_RULE).toContain('due_at is today')
	})

	it('tells the agent to just do ordinary changes, and for a held one to call first and ask once', () => {
		const text = buildVoiceInstructions(base)
		expect(text).toContain(VOICE_WRITE_CONFIRMATION)
		expect(VOICE_WRITE_CONFIRMATION).toContain('run at once')
		expect(VOICE_WRITE_CONFIRMATION).toContain('without asking first')
		expect(VOICE_WRITE_CONFIRMATION).toContain('confirmation_id')
	})

	it('tells the agent a filler sound is never a decision and to read the decision back', () => {
		expect(buildVoiceInstructions(base)).toContain(VOICE_DECISION_RULE)
		expect(VOICE_DECISION_RULE).toContain('"Mm", "mhm"')
		expect(VOICE_DECISION_RULE).toContain('"go on" meaning keep talking')
		expect(VOICE_DECISION_RULE).toContain('read the decision back in one short sentence')
	})

	it('tells the agent to save changed wording and read it back before asking for approval', () => {
		expect(buildVoiceInstructions(base)).toContain(VOICE_DRAFT_RULE)
		expect(VOICE_DRAFT_RULE).toContain(
			"save the new wording with update_objects on the draft's task",
		)
		expect(VOICE_DRAFT_RULE).toContain('read back what was saved from the result')
		expect(VOICE_DRAFT_RULE.indexOf('read back')).toBeLessThan(
			VOICE_DRAFT_RULE.indexOf('ask for approval'),
		)
	})

	it('tells the agent a draft or card is answered by tapping it, not by a spoken yes', () => {
		expect(VOICE_DRAFT_RULE).toContain('approved by tapping it in the chat')
		expect(VOICE_DRAFT_RULE).toContain('decision card is answered by tapping it')
		expect(VOICE_DRAFT_RULE).toContain('a spoken yes does not approve a draft or answer a card')
	})

	it('tells the agent to report a background job only from a tool result of the same turn', () => {
		expect(VOICE_DRAFT_RULE).toContain(
			'running or done only from a tool result you received in this same turn',
		)
	})

	it('tells the agent to call a change done only after its tool result says it ran, and that the chat shows a receipt', () => {
		expect(buildVoiceInstructions(base)).toContain(VOICE_DRAFT_RULE)
		expect(VOICE_DRAFT_RULE).toContain('only after its tool result says it ran')
		expect(VOICE_DRAFT_RULE).toContain('the chat shows a receipt')
	})

	it('tells the agent to show drafts, lists and links in the chat instead of reading them out', () => {
		expect(VOICE_CALL_CONDUCT).toContain('show_in_chat')
		expect(VOICE_CALL_CONDUCT).toContain('short summary')
		expect(VOICE_CALL_CONDUCT).toContain('never read an address out loud')
	})

	it('forbids a spoken heads-up before a tool call', () => {
		expect(VOICE_CALL_CONDUCT).toContain('Never speak before a tool call')
		expect(VOICE_CALL_CONDUCT).toContain('let me pull that up')
	})

	it('keeps the agent prompt first, then skills, then the earlier chat', () => {
		const text = buildVoiceInstructions({
			...base,
			skills: [{ name: 'triage', content: 'Triage rules.' }],
			chatHistory: 'Earlier in this chat: hello',
		})
		expect(text.startsWith('You are the agent.')).toBe(true)
		expect(text.indexOf(VOICE_CALL_CONDUCT)).toBeLessThan(text.indexOf('## Skill: triage'))
		expect(text.indexOf('## Skill: triage')).toBeLessThan(text.indexOf('Earlier in this chat'))
		expect(text).toContain('workspace_id')
	})
})
