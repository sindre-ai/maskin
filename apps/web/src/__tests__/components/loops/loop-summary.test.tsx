import { LoopSummary, buildLoopSummarySentences } from '@/components/loops/loop-summary'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { buildLoopSummary } from '../../factories'

describe('buildLoopSummarySentences', () => {
	it('builds four sentences from real loop data', () => {
		const loop = buildLoopSummary({
			name: 'Feedback loop',
			content: 'Every customer hears back within 30 days',
			entryCondition: 'A new piece of customer feedback lands in the inbox',
			closeCondition: 'the customer follows up',
			pill: 'learning',
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

	it('falls back to a name-based sentence when no content is set', () => {
		const loop = buildLoopSummary({ name: 'Billing reliability', content: null })
		const sentences = buildLoopSummarySentences(loop)
		expect(sentences[0]).toBe('Billing reliability keeps the workspace moving on its own.')
	})

	it('says it is waiting on you when the pill is waiting_on_you', () => {
		const loop = buildLoopSummary({ pill: 'waiting_on_you' })
		const sentences = buildLoopSummarySentences(loop)
		expect(sentences[3]).toBe('Right now it is waiting on you.')
	})

	it('says it is a draft when the pill is draft', () => {
		const sentences = buildLoopSummarySentences(buildLoopSummary({ pill: 'draft' }))
		expect(sentences[3]).toBe('Right now it is a draft — not live yet.')
	})

	it('says it is paused when the pill is paused', () => {
		const sentences = buildLoopSummarySentences(buildLoopSummary({ pill: 'paused' }))
		expect(sentences[3]).toBe('Right now it is paused.')
	})
})

describe('LoopSummary', () => {
	it('renders each sentence as a paragraph', () => {
		render(<LoopSummary loop={buildLoopSummary({ content: 'The loop content' })} />)
		expect(screen.getByText('The loop content')).toBeInTheDocument()
	})
})
