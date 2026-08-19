import {
	LoopSummary,
	buildLoopSummarySentences,
	loopSummarySentenceText,
} from '@/components/loops/loop-summary'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { buildLoopSummary } from '../../factories'

function texts(loop: Parameters<typeof buildLoopSummarySentences>[0]): string[] {
	return buildLoopSummarySentences(loop).map(loopSummarySentenceText)
}

describe('buildLoopSummarySentences', () => {
	it('builds four sentences from real loop data', () => {
		const loop = buildLoopSummary({
			name: 'Feedback loop',
			content: 'Every customer hears back within 30 days',
			entryCondition: 'A new piece of customer feedback lands in the inbox',
			closeCondition: 'the customer follows up',
			pill: 'supervised',
			inProgressCount: 3,
		})

		const sentences = texts(loop)

		expect(sentences).toHaveLength(4)
		expect(sentences[0]).toBe('Every customer hears back within 30 days')
		expect(sentences[1]).toBe(
			'New work enters when a new piece of customer feedback lands in the inbox.',
		)
		expect(sentences[2]).toBe('A cycle closes when the customer follows up.')
		expect(sentences[3]).toBe('Right now 3 items are in progress.')
	})

	it('segments the key noun so it renders at full ink against the muted body', () => {
		const loop = buildLoopSummary({
			content: null,
			name: 'Billing reliability',
			entryCondition: 'a payment fails',
			pill: 'paused',
		})
		const sentences = buildLoopSummarySentences(loop)

		expect(sentences[1]).toEqual([
			{ text: 'New work enters when ' },
			{ text: 'a payment fails', emphasis: true },
			{ text: '.' },
		])
		expect(sentences[3]).toEqual([
			{ text: 'Right now it is ' },
			{ text: 'paused', emphasis: true },
			{ text: '.' },
		])
	})

	it('falls back to a name-based outcome when none is set', () => {
		const loop = buildLoopSummary({ name: 'Billing reliability', content: null })
		expect(texts(loop)[0]).toBe('Billing reliability keeps the workspace moving on its own.')
	})

	it('says it is waiting on you when the pill is waiting_on_you', () => {
		const loop = buildLoopSummary({ pill: 'waiting_on_you' })
		expect(texts(loop)[3]).toBe('Right now it is waiting on you.')
	})

	it('says it is paused when the pill is paused', () => {
		expect(texts(buildLoopSummary({ pill: 'paused' }))[3]).toBe('Right now it is paused.')
	})
})

describe('LoopSummary', () => {
	it('renders each sentence as a paragraph', () => {
		render(<LoopSummary loop={buildLoopSummary({ content: 'The loop outcome' })} />)
		expect(screen.getByText('The loop outcome')).toBeInTheDocument()
	})

	it('carries no edit control — the composer below the loop is the only way in', () => {
		render(<LoopSummary loop={buildLoopSummary()} />)
		expect(screen.queryByRole('button', { name: /edit this loop/i })).not.toBeInTheDocument()
		expect(screen.queryByText('say what should change — no builder')).not.toBeInTheDocument()
	})
})
