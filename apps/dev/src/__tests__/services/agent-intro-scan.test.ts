import { describe, expect, it } from 'vitest'
import { buildIntroScanPrompt, parseIntroScanResult } from '../../services/agent-intro-scan'

describe('parseIntroScanResult', () => {
	it('reads a bare JSON reply', () => {
		const result = parseIntroScanResult(
			'{"steps":[{"label":"Triage Linear","prompt":"Triage Linear","action":"send"}],"needed_integrations":["linear"]}',
		)
		expect(result).toEqual({
			steps: [{ label: 'Triage Linear', prompt: 'Triage Linear', action: 'send' }],
			neededIntegrations: ['linear'],
		})
	})

	it('finds the object inside a fence or a lead-in sentence', () => {
		const result = parseIntroScanResult(
			'Here you go:\n```json\n{"steps":[{"label":"Check Gmail","prompt":"Reply to: ","action":"fill"}]}\n```',
		)
		expect(result?.steps).toHaveLength(1)
		expect(result?.neededIntegrations).toEqual([])
	})

	it('repairs a send step whose prompt differs from its label', () => {
		const result = parseIntroScanResult(
			'{"steps":[{"label":"Summarise bugs","prompt":"Please summarise all bugs","action":"send"}]}',
		)
		expect(result?.steps[0]).toEqual({
			label: 'Summarise bugs',
			prompt: 'Summarise bugs',
			action: 'send',
		})
	})

	it('drops invalid steps and keeps at most three', () => {
		const step = (n: number) => ({ label: `Step ${n}`, prompt: `Step ${n}`, action: 'send' })
		const result = parseIntroScanResult(
			JSON.stringify({
				steps: [{ label: '', prompt: 'x', action: 'send' }, step(1), step(2), step(3), step(4)],
			}),
		)
		expect(result?.steps.map((s) => s.label)).toEqual(['Step 1', 'Step 2', 'Step 3'])
	})

	it.each([
		['empty', ''],
		['null', null],
		['prose only', 'I looked around and found nothing.'],
		['broken json', '{"steps": ['],
		['no steps key', '{"foo":1}'],
		['no valid step', '{"steps":[{"label":"x"}]}'],
	])('returns null for %s', (_name, text) => {
		expect(parseIntroScanResult(text)).toBeNull()
	})
})

describe('buildIntroScanPrompt', () => {
	it('names the agent, the person and the read-only tools to look at', () => {
		const prompt = buildIntroScanPrompt({
			workspaceId: 'ws',
			agent: { id: 'a', name: 'Scout', description: 'Finds leads' },
			recipient: { id: 'h', name: 'Sam Rivers' },
		})
		expect(prompt).toContain('"Scout"')
		expect(prompt).toContain('Sam Rivers')
		expect(prompt).toContain('list_integrations')
		expect(prompt).toContain('list_keychain_credentials')
	})
})
