import { describe, expect, it } from 'vitest'
import { type DecideWakesInput, decideWakes } from '../conversation-wake-rule'

const H1 = { id: 'h1', type: 'human' as const }
const H2 = { id: 'h2', type: 'human' as const }
const A = { id: 'a', type: 'agent' as const }
const B = { id: 'b', type: 'agent' as const }

/** The scripted chat: two people, two agents. H1 is the sender unless a case says otherwise. */
function decide(overrides: Partial<DecideWakesInput> = {}) {
	return decideWakes({
		author: H1,
		mentions: [],
		participants: [H1, H2, A, B],
		previousOther: { authorId: A.id, authorType: 'agent' },
		isFirstMessage: false,
		consecutiveAgentTail: 0,
		maxConsecutiveAgents: 5,
		...overrides,
	})
}

const woken = (r: ReturnType<typeof decideWakes>) => r.wakes.map((w) => w.agentId).sort()

describe('decideWakes truth table', () => {
	it('wakes the tagged agent when a person tags one agent', () => {
		const r = decide({ mentions: [A.id] })
		expect(r.rule).toBe('tagged')
		expect(r.wakes).toEqual([{ agentId: A.id, reason: 'rule_tagged' }])
		expect(r.skips).toEqual([{ agentId: B.id, reason: 'skip_not_addressed' }])
	})

	it('wakes the other agent when the person tags B although A spoke last', () => {
		const r = decide({ mentions: [B.id] })
		expect(woken(r)).toEqual([B.id])
	})

	it('wakes both when a person tags A and B', () => {
		const r = decide({ mentions: [A.id, B.id] })
		expect(woken(r)).toEqual([A.id, B.id])
		expect(r.skips).toEqual([])
	})

	it('wakes an agent once when it is tagged twice', () => {
		expect(decide({ mentions: [A.id, A.id] }).wakes).toHaveLength(1)
	})

	it('wakes nobody when a person tags another person', () => {
		const r = decide({ mentions: [H2.id] })
		expect(r.rule).toBe('human_tag_only')
		expect(r.wakes).toEqual([])
		expect(r.skips.map((s) => s.reason)).toEqual(['skip_human_tag_only', 'skip_human_tag_only'])
	})

	it('ignores the person tagged next to an agent', () => {
		const r = decide({ mentions: [H2.id, A.id] })
		expect(woken(r)).toEqual([A.id])
	})

	it('wakes nobody when the tag is an id that is not in the chat', () => {
		expect(decide({ mentions: ['stranger'] }).wakes).toEqual([])
	})

	it('wakes nobody when the tagged agent has left the chat', () => {
		const r = decide({ mentions: [B.id], participants: [H1, H2, A] })
		expect(r.rule).toBe('human_tag_only')
		expect(r.wakes).toEqual([])
	})

	it('wakes the last speaker when a person writes untagged after agent A', () => {
		const r = decide()
		expect(r.rule).toBe('last_speaker')
		expect(r.wakes).toEqual([{ agentId: A.id, reason: 'rule_last_speaker' }])
	})

	it('wakes B when a person writes untagged after agent B', () => {
		const r = decide({ previousOther: { authorId: B.id, authorType: 'agent' } })
		expect(woken(r)).toEqual([B.id])
	})

	it('wakes A when a second person replies untagged right after A answered', () => {
		const r = decide({ author: H2 })
		expect(woken(r)).toEqual([A.id])
	})

	it('wakes nobody when another person spoke after the agent', () => {
		const r = decide({ previousOther: { authorId: H2.id, authorType: 'human' } })
		expect(r.rule).toBe('last_speaker')
		expect(r.wakes).toEqual([])
		expect(r.skips.map((s) => s.reason)).toEqual([
			'skip_last_writer_person',
			'skip_last_writer_person',
		])
	})

	it('wakes nobody when the last speaker has left the chat', () => {
		const r = decide({ participants: [H1, H2, B] })
		expect(r.wakes).toEqual([])
		expect(r.skips).toEqual([{ agentId: B.id, reason: 'skip_last_writer_gone' }])
	})

	it('wakes the only agent on the first untagged message', () => {
		const r = decide({
			participants: [H1, H2, A],
			previousOther: null,
			isFirstMessage: true,
		})
		expect(r.rule).toBe('first_message_lone_agent')
		expect(r.wakes).toEqual([{ agentId: A.id, reason: 'rule_first_message_lone_agent' }])
	})

	it('wakes nobody on the first untagged message when two agents are in the chat', () => {
		const r = decide({ previousOther: null, isFirstMessage: true })
		expect(r.rule).toBe('no_target')
		expect(r.wakes).toEqual([])
		expect(r.skips.map((s) => s.reason)).toEqual(['skip_no_target', 'skip_no_target'])
	})

	it('wakes nobody when a person writes again and nobody else has written yet', () => {
		const r = decide({ previousOther: null, isFirstMessage: false })
		expect(r.rule).toBe('no_target')
		expect(r.wakes).toEqual([])
	})

	it('wakes the tagged agent on a first message that tags one of two agents', () => {
		const r = decide({ previousOther: null, isFirstMessage: true, mentions: [B.id] })
		expect(woken(r)).toEqual([B.id])
	})

	it('wakes nobody when an agent posts untagged', () => {
		const r = decide({ author: A, previousOther: { authorId: H1.id, authorType: 'human' } })
		expect(r.rule).toBe('agent_untagged')
		expect(r.wakes).toEqual([])
		expect(r.skips).toEqual([{ agentId: B.id, reason: 'skip_agent_untagged' }])
	})

	it('wakes only B when agent A posts tagging B', () => {
		const r = decide({ author: A, mentions: [B.id] })
		expect(woken(r)).toEqual([B.id])
	})

	it('never wakes the author, even when it tags itself', () => {
		const r = decide({ author: A, mentions: [A.id] })
		expect(r.wakes).toEqual([])
	})

	it('wakes the chosen agent on a redo', () => {
		const r = decide({
			retryTargetId: A.id,
			previousOther: { authorId: B.id, authorType: 'agent' },
		})
		expect(r.rule).toBe('retry_target')
		expect(r.wakes).toEqual([{ agentId: A.id, reason: 'rule_retry_target' }])
		expect(r.skips).toEqual([{ agentId: B.id, reason: 'skip_not_addressed' }])
	})

	it('wakes nobody on a redo that names someone who is not an agent in the chat', () => {
		expect(decide({ retryTargetId: H2.id }).wakes).toEqual([])
	})

	it('follows the normal rule on a retry with no agent chosen', () => {
		expect(decide({ retryTargetId: undefined })).toEqual(decide())
		expect(woken(decide({ mentions: [B.id] }))).toEqual([B.id])
	})

	it('wakes nobody once five agent messages are in a row, even for a tag or a redo', () => {
		const tagged = decide({ mentions: [A.id], consecutiveAgentTail: 5 })
		expect(tagged.rule).toBe('agent_cap')
		expect(tagged.wakes).toEqual([])
		expect(tagged.skips.map((s) => s.reason)).toEqual(['dropped_agent_cap', 'dropped_agent_cap'])
		expect(decide({ retryTargetId: A.id, consecutiveAgentTail: 5 }).wakes).toEqual([])
	})

	it('still wakes at four agent messages in a row', () => {
		expect(woken(decide({ mentions: [A.id], consecutiveAgentTail: 4 }))).toEqual([A.id])
	})

	it('returns no skips and no wakes when the chat has no agent', () => {
		const r = decide({ participants: [H1, H2], previousOther: null })
		expect(r.wakes).toEqual([])
		expect(r.skips).toEqual([])
	})

	it('does not change its inputs', () => {
		const mentions = [A.id]
		const participants = [H1, H2, A, B]
		decide({ mentions, participants })
		expect(mentions).toEqual([A.id])
		expect(participants).toEqual([H1, H2, A, B])
	})
})
