import { describe, expect, it } from 'vitest'
import {
	NOTE_MAX_CHARS,
	type NoteItem,
	buildCapabilityNote,
	cleanText,
	scopeLabel,
} from '../../../lib/capabilities/note-template'

const FULL: NoteItem[] = [
	{
		kind: 'new_tools',
		integration: 'Slack',
		tools: ['slack_react', 'slack_pin'],
		agents: ['Sales Rep', 'Personal Assistant'],
	},
	{ kind: 'needs_reconnect', integration: 'Gmail', scopes: ['https://mail.google.com/gmail.send'] },
	{ kind: 'not_attached', integration: 'Notion' },
]

function manyItems(count: number): NoteItem[] {
	return Array.from({ length: count }, (_, i) => ({
		kind: 'new_tools' as const,
		integration: `Source ${i + 1}`,
		tools: [`tool_${i + 1}`],
		agents: ['Researcher'],
	}))
}

describe('buildCapabilityNote', () => {
	it('writes the agreed wording for all three item types', () => {
		const { content, shown, hidden } = buildCapabilityNote({ firstName: 'Sam', items: FULL })
		expect(shown).toBe(3)
		expect(hidden).toBe(0)
		expect(content).toBe(
			'Hey Sam, here is what your agents can now do. ' +
				'Your Sales Rep and Personal Assistant can now react and pin in Slack. ' +
				'Needs you: Gmail needs a reconnect before your agents can use the new send access. ' +
				'Also: Notion is connected but none of your agents can use it yet. An admin decides whether any agent gets it. ' +
				'Reply "tell me more" and I will go through any of it. Reply "stop" and I will not send these.',
		)
	})

	it('has no long dash, no backtick and stays under 900 characters', () => {
		const { content } = buildCapabilityNote({ firstName: 'Sam', items: FULL })
		expect(content).not.toMatch(/—|–/)
		expect(content).not.toContain('`')
		expect(content.length).toBeLessThanOrEqual(NOTE_MAX_CHARS)
	})

	it('shows no snake_case tool name, only what the agents can now do', () => {
		const { content } = buildCapabilityNote({
			firstName: 'Sam',
			items: [
				{
					kind: 'new_tools',
					integration: 'Slack',
					tools: [
						'slack_react',
						'slack_pin',
						'slack_send_message',
						'slack_list_channels',
						'mcp__slack__get_user',
					],
					agents: ['Sales Rep'],
				},
			],
		})
		expect(content).not.toMatch(/[a-z]+_[a-z]+/)
		expect(content).toContain(
			'Your Sales Rep can now react, pin, send message and 2 other things in Slack.',
		)
	})

	it('shows three apps and then says and N more', () => {
		const { content, shown, hidden } = buildCapabilityNote({
			firstName: 'Sam',
			items: manyItems(8),
		})
		expect(shown).toBe(3)
		expect(hidden).toBe(5)
		expect(content).toContain('And 5 more.')
		expect(content).toContain('Source 3')
		expect(content).not.toContain('Source 4')
		expect(content.length).toBeLessThanOrEqual(NOTE_MAX_CHARS)
	})

	it('has no and N more line at three items or fewer', () => {
		const { content } = buildCapabilityNote({ firstName: 'Sam', items: manyItems(3) })
		expect(content).not.toMatch(/and \d+ more\./i)
	})

	it('drops items from the end rather than pass 900 characters', () => {
		const long = 'x'.repeat(40)
		const items: NoteItem[] = Array.from({ length: 3 }, (_, i) => ({
			kind: 'new_tools' as const,
			integration: `${long}${i}`,
			tools: [`a${long}`, `b${long}`, `c${long}`, `d${long}`],
			agents: [`${long}1`, `${long}2`, `${long}3`, `${long}4`],
		}))
		const { content, shown, hidden } = buildCapabilityNote({ firstName: 'Sam', items })
		expect(content.length).toBeLessThanOrEqual(NOTE_MAX_CHARS)
		expect(shown).toBeLessThan(3)
		expect(shown + hidden).toBe(3)
		expect(content).toMatch(/and \d+ more\./i)
	})

	it('never says grant or attach and names no agent on the not-attached line', () => {
		const { content } = buildCapabilityNote({
			firstName: 'Sam',
			items: [{ kind: 'not_attached', integration: 'Notion' }],
		})
		expect(content).not.toMatch(/grant|attach/i)
		const also = content.split('Also: ')[1]?.split(' Reply')[0] ?? ''
		expect(also).toBe(
			'Notion is connected but none of your agents can use it yet. An admin decides whether any agent gets it.',
		)
	})

	it('cleans long dashes, backticks and line breaks out of names', () => {
		const { content } = buildCapabilityNote({
			firstName: 'Sam',
			items: [
				{
					kind: 'new_tools',
					integration: 'Sl`ack — Pro\nTeam',
					tools: ['do`it'],
					agents: ['A–B'],
				},
			],
		})
		expect(content).not.toMatch(/—|–|`|\n/)
		expect(content).toContain('Your A-B can now do it in Sl-ack - Pro Team.')
	})

	it('falls back to there when there is no first name', () => {
		const { content } = buildCapabilityNote({ firstName: '', items: FULL })
		expect(content.startsWith('Hey there, here is what')).toBe(true)
	})

	it('carries no decision, approval or spend language', () => {
		const { content } = buildCapabilityNote({ firstName: 'Sam', items: FULL })
		expect(content).not.toMatch(/approve|approval|budget|spend|risk/i)
	})
})

describe('cleanText and scopeLabel', () => {
	it('cuts to the length limit', () => {
		expect(cleanText('a'.repeat(100), 10)).toHaveLength(10)
	})

	it('shows only the last readable part of a scope', () => {
		expect(scopeLabel('https://www.googleapis.com/auth/gmail.send')).toBe('send')
		expect(scopeLabel('chat:write')).toBe('write')
		expect(scopeLabel('users:read.email')).toBe('email')
	})
})
