import { LoopSummary, buildLoopSummarySentences } from '@/components/loops/loop-summary'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { buildLoopSummary } from '../../factories'

describe('buildLoopSummarySentences', () => {
	it('builds four sentences from real loop data', () => {
		const loop = buildLoopSummary({
			name: 'Feedback loop',
			guarantee: 'Every customer hears back within 30 days',
			entryCondition: 'A new piece of customer feedback lands in the inbox',
			closeCondition: 'the customer follows up',
			pill: 'running',
			inProgressCount: 3,
		})

		const sentences = buildLoopSummarySentences(loop)

		expect(sentences).toHaveLength(4)
		expect(sentences[0]).toBe('Every customer hears back within 30 days')
		expect(sentences[1]).toBe(
			'New work enters when a new piece of customer feedback lands in the inbox.',
		)
		expect(sentences[2]).toBe('A cycle closes when the customer follows up.')
		expect(sentences[3]).toBe('Right now 3 items are in progress.')
	})

	it('falls back to a name-based guarantee when none is set', () => {
		const loop = buildLoopSummary({ name: 'Billing reliability', guarantee: null })
		const sentences = buildLoopSummarySentences(loop)
		expect(sentences[0]).toBe('Billing reliability keeps the workspace moving on its own.')
	})

	it('says it is waiting on you with decision points when the pill is waiting_on_you', () => {
		const loop = buildLoopSummary({
			pill: 'waiting_on_you',
			humanDecisionPoints: 2,
		})
		const sentences = buildLoopSummarySentences(loop)
		expect(sentences[3]).toBe('Right now it is waiting on you, with 2 decision points open.')
	})

	it('says it is paused when the pill is paused', () => {
		const sentences = buildLoopSummarySentences(buildLoopSummary({ pill: 'paused' }))
		expect(sentences[3]).toBe('Right now it is paused.')
	})
})

describe('LoopSummary', () => {
	it('renders each sentence as a paragraph', () => {
		render(<LoopSummary loop={buildLoopSummary({ guarantee: 'The loop guarantee' })} />)
		expect(screen.getByText('The loop guarantee')).toBeInTheDocument()
	})
})
