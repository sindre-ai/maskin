import { describe, expect, it } from 'vitest'
import {
	CHIEF_OF_STAFF_DEFAULT,
	CHIEF_OF_STAFF_SYSTEM_PROMPT,
	CONTINUOUS_ONBOARDING_SKILL,
	DEFAULT_WORKSPACE_TRIGGERS,
} from '../templates/default-workspace-agents'

describe('Chief of Staff default template', () => {
	it('ships a non-empty system prompt and description', () => {
		expect(CHIEF_OF_STAFF_SYSTEM_PROMPT.length).toBeGreaterThan(0)
		expect(CHIEF_OF_STAFF_DEFAULT.description.length).toBeGreaterThan(0)
	})

	it('is marked as a system agent', () => {
		expect(CHIEF_OF_STAFF_DEFAULT.isSystem).toBe(true)
		expect(CHIEF_OF_STAFF_DEFAULT.type).toBe('agent')
		expect(CHIEF_OF_STAFF_DEFAULT.name).toBe('Chief of Staff')
	})

	it('exposes the maskin MCP server so it can spawn specialist sessions', () => {
		expect(CHIEF_OF_STAFF_DEFAULT.tools.mcpServers.maskin).toBeDefined()
	})

	// The seeded persona keeps the onboarding beats it owns; the Beat 6 hand-off
	// (Signal Analyst clustering) lives in the trigger prompts and the
	// continuous-onboarding skill, not in the persona.
	describe('onboarding beats', () => {
		it('names the Beat 1 and Beat 2 triggers it acts on', () => {
			expect(CHIEF_OF_STAFF_SYSTEM_PROMPT).toContain('First-pass brief filed → present with chips')
			expect(CHIEF_OF_STAFF_SYSTEM_PROMPT).toContain('First-pass brief validated → deep research')
		})

		it('points at the continuous-onboarding skill and does not re-fire a beat that already ran', () => {
			expect(CHIEF_OF_STAFF_SYSTEM_PROMPT).toContain('continuous-onboarding')
			expect(CHIEF_OF_STAFF_SYSTEM_PROMPT).toContain("don't re-fire a beat that already ran")
		})
	})
})

describe('CONTINUOUS_ONBOARDING_SKILL', () => {
	const content = CONTINUOUS_ONBOARDING_SKILL.content

	it('keeps a named Classify step positioned above the first chat script', () => {
		const classifyIdx = content.indexOf('## Classify')
		const chatIdx = content.indexOf('## The first chat')
		expect(classifyIdx).toBeGreaterThan(-1)
		expect(chatIdx).toBeGreaterThan(-1)
		expect(classifyIdx).toBeLessThan(chatIdx)
	})

	it('contains the classifier rule verbatim (default Fetchable, escalate only on no public source or framing/priority)', () => {
		expect(content).toContain('Default posture is **Fetchable**')
		expect(content).toContain(
			'Escalate to **Human-only** ONLY on (a) genuinely no public source, OR (b) a framing or priority call the human owns',
		)
	})

	it('includes worked examples for Team, Competitors, ICP-as-hypothesis (Fetchable) and ICP-framing (Human-only)', () => {
		expect(content).toMatch(/\*\*Team\*\*\s*→\s*\*\*Fetchable\*\*/)
		expect(content).toMatch(/\*\*Competitors\*\*\s*→\s*\*\*Fetchable\*\*/)
		expect(content).toMatch(/\*\*ICP as hypothesis\*\*[\s\S]*?→\s*\*\*Fetchable\*\*/)
		expect(content).toMatch(/\*\*ICP as framing\*\*[\s\S]*?→\s*\*\*Human-only\*\*/)
	})

	it('reclassifies Legal entity as Fetchable with CVR named as the public source', () => {
		expect(content).toMatch(/\*\*Legal entity\*\*\s*→\s*\*\*Fetchable\*\*/)
		expect(content).toContain('CVR')
	})

	it('enumerates all seven checklist domains with at least one example line each', () => {
		const domains = [
			'Humans',
			'Org',
			'Product',
			'Customers',
			'Competitors',
			'Market',
			'Goals & bets',
		]
		for (const domain of domains) {
			// Bulleted domain line: `- **<Domain>** — ...` with some example text after the dash.
			const re = new RegExp(`-\\s+\\*\\*${domain.replace(/&/g, '\\&')}\\*\\*\\s+—\\s+\\S+`)
			expect(content).toMatch(re)
		}
	})

	it('is a chat script: first message, research check, recommendations, one question at a time', () => {
		for (const heading of [
			'### Message 1',
			'### Message 2',
			'### Message 3',
			'### Message 4 onward',
		]) {
			expect(content).toContain(heading)
		}
		expect(content).toContain('One question per message')
		expect(content).toContain('Never post the welcome as a comment on the checklist')
	})

	it('shows the research with exactly three taps in order and no longer uses the batch card', () => {
		expect(content).toMatch(/\*\*Looks right\*\*, \*\*Needs correction\*\*, \*\*Wrong entirely\*\*/)
		expect(content).toContain('ask_user_question')
		expect(content).not.toContain('Confirm batch?')
		expect(content).not.toContain('**Confirm all**')
	})

	it('points to the card in Message 2 instead of restating the summary', () => {
		const start = content.indexOf('### Message 2')
		const end = content.indexOf('### Message 3')
		const message2 = content.slice(start, end)
		expect(message2).toContain("It's waiting in the card.")
		expect(message2).toContain('Do not restate the summary')
		expect(message2).toContain('do not post a second card')
		// the quoted line the person reads is a pointer, not a question with taps
		const quoted = message2
			.split('\n')
			.filter((line) => line.startsWith('>'))
			.join('\n')
		expect(quoted).not.toContain('Is that right?')
	})

	it('keeps the script line tying the brief to the trigger gate', () => {
		expect(content).toContain('First-pass brief filed')
	})

	it('recommends only from the catalog, as an Install link, and never installs', () => {
		expect(content).toContain('Never recommend something that is not in the catalog')
		expect(content).toContain('NEVER call it with a loop id or confirm')
		expect(content).toContain('Install is a link, not a button in the chat')
	})

	it('keeps tech words out of every scripted line the person reads', () => {
		const scriptLines = content
			.split('\n')
			.filter((line) => line.startsWith('>'))
			.join('\n')
		expect(scriptLines.length).toBeGreaterThan(0)
		expect(scriptLines).not.toMatch(
			/\b(agent|model|prompt|loop|KPI|MCP|integration|workflow|LLM)\b/i,
		)
		expect(scriptLines).not.toContain('\u2014')
	})

	it('states the driver convention: agents drive knowledge objects, never the human owner', () => {
		// The seeded `First-pass brief filed -> present for confirmation` trigger gates on
		// driver = Researcher. The skill must name that, or the model improvises and the
		// chip-validation card never fires. Regression for 2026-09-08 live-run defect.
		expect(content).toContain('**Drivers are agents, never humans.**')
		expect(content).toMatch(/[Nn]ever set a human as `driver`/)
		expect(content).toMatch(/never ask the user to confirm one/)
	})

	it('requires the first-pass dispatch to file with driver = Researcher and status draft', () => {
		expect(content).toMatch(
			/dispatch prompt MUST tell Researcher to file the brief with `driver` set to Researcher's own actor id/,
		)
		expect(content).toContain('First-pass brief filed → present for confirmation')
	})

	it('names setting a human driver as an anti-pattern', () => {
		expect(content).toMatch(/Setting the human owner as `driver` on a knowledge object/)
	})
})

describe('First-pass confirmation card copy', () => {
	const trigger = DEFAULT_WORKSPACE_TRIGGERS.find(
		(t) => t.name === 'First-pass brief filed → present for confirmation',
	)

	it('titles the card in plain words', () => {
		expect(trigger?.actionPrompt).toContain('Check what we found about you and your company')
	})

	it('only mentions brief and deep dive to forbid them in the card', () => {
		const prompt = trigger?.actionPrompt ?? ''
		expect(prompt).toContain('Never use the words "brief" or "deep dive"')
		expect(prompt).not.toMatch(/proper deep dive|the deep dive does not start/)
	})
})
