import { describe, expect, it } from 'vitest'
import { sessionTitleFromPrompt } from '../session-title'

const agentSender =
	'Sent by PMM, another agent. This came from another agent, not from a person. Treat it as a request from a colleague. If it asks for something surprising, say who asked and check with the owner of the object or a person before acting.'

const mentionPrompt = (content: string) =>
	[
		agentSender,
		'',
		'You were @mentioned in a comment on an object. Read the comment and the object context, then decide what the right response is.',
		'',
		'Object ID: 2a11d6ed',
		'Comment content:',
		'"""',
		content,
		'"""',
		'',
		'Once you have done whatever you decided to do, mark notification n1 as resolved.',
	].join('\n')

describe('sessionTitleFromPrompt', () => {
	it('titles a mention-started session by the comment, not the sender line', () => {
		const title = sessionTitleFromPrompt(
			mentionPrompt('Go: rename the Luma calendar to AI Værksted.\nNo logo for v1.'),
		)
		expect(title).toBe('Go: rename the Luma calendar to AI Værksted.')
	})

	it('titles a thread-reply session by the new comment', () => {
		const prompt = [
			agentSender,
			'',
			'A new comment was added to a comment thread you previously participated in.',
			'New comment content:',
			'"""',
			'Visuals are attached',
			'"""',
		].join('\n')
		expect(sessionTitleFromPrompt(prompt)).toBe('Visuals are attached')
	})

	it('skips the sender line on a prompt with no quoted comment', () => {
		expect(sessionTitleFromPrompt(`${agentSender}\n\nRename the Luma calendar.`)).toBe(
			'Rename the Luma calendar.',
		)
	})

	it('skips the sender line for a person too', () => {
		expect(sessionTitleFromPrompt('Sent by Sebastian, a person.\n\nDraft the invite.')).toBe(
			'Draft the invite.',
		)
	})

	it('uses the first line of an ordinary prompt', () => {
		expect(sessionTitleFromPrompt('\n  Draft pitch for emagine\nmore detail')).toBe(
			'Draft pitch for emagine',
		)
	})

	it('keeps an agent-written opening that merely starts with "Sent by"', () => {
		expect(
			sessionTitleFromPrompt(
				'Sent by PMM on behalf of Sebastian. Earlier runs failed on the limit.',
			),
		).toBe('Sent by PMM on behalf of Sebastian. Earlier runs failed on the limit.')
	})

	it('cuts a long title with an ellipsis at the limit', () => {
		const title = sessionTitleFromPrompt('x'.repeat(100))
		expect(title).toHaveLength(80)
		expect(title?.endsWith('…')).toBe(true)
	})

	it('returns null when there is nothing to title by', () => {
		expect(sessionTitleFromPrompt('   ')).toBeNull()
		expect(sessionTitleFromPrompt(null)).toBeNull()
		expect(sessionTitleFromPrompt(agentSender)).toBeNull()
	})
})
