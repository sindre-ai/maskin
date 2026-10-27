import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

import { VoiceEventRow, VoiceSummaryCard } from '@/components/chat/voice-receipts'
import type { VoiceReceiptRow, VoiceReceiptSummary } from '@/lib/voice-receipts'

const row: VoiceReceiptRow = {
	kind: 'receipt',
	voiceSessionId: 'vs-1',
	event: 'moved_to_review',
	objectId: 'obj-1',
	text: 'Aggregate review + open bet PR',
	t: 16,
	outcome: 'ran',
}

const summary: VoiceReceiptSummary = {
	kind: 'receipt_summary',
	voiceSessionId: 'vs-1',
	durationSeconds: 3604,
	decided: ['Backfill cancelled bookings'],
	created: [{ type: 'bet', title: 'Backfill bet', objectId: 'obj-2' }],
	next: ['Code Reviewer picks up the PR today'],
	notDone: [],
}

describe('VoiceEventRow', () => {
	it('shows the call time, the kind label and the text', () => {
		render(<VoiceEventRow receipt={row} workspaceId="ws-1" />)
		expect(screen.getByText('0:16')).toBeInTheDocument()
		expect(screen.getByText('Moved to review')).toBeInTheDocument()
		expect(screen.getByText('Aggregate review + open bet PR')).toBeInTheDocument()
	})

	it('links to the object when it names one', () => {
		render(<VoiceEventRow receipt={row} workspaceId="ws-1" />)
		expect(screen.getByRole('link')).toBeInTheDocument()
	})

	it('is not a link when no object is named', () => {
		render(<VoiceEventRow receipt={{ ...row, objectId: null }} workspaceId="ws-1" />)
		expect(screen.queryByRole('link')).toBeNull()
	})

	it('says plainly when the change did not happen', () => {
		render(<VoiceEventRow receipt={{ ...row, outcome: 'failed' }} workspaceId="ws-1" />)
		expect(screen.getByText('Failed')).toBeInTheDocument()
		expect(screen.queryByText('Moved to review')).toBeNull()
	})
})

describe('VoiceSummaryCard', () => {
	const base = {
		workspaceId: 'ws-1',
		transcriptOpen: false,
		canReadTranscript: true,
		onToggleTranscript: () => {},
	}

	it('shows the duration and the Decided, Created and Next sections', () => {
		render(<VoiceSummaryCard summary={summary} {...base} />)
		expect(screen.getByText('1:00:04')).toBeInTheDocument()
		expect(screen.getByText('Decided · 1')).toBeInTheDocument()
		expect(screen.getByText('Created · 1')).toBeInTheDocument()
		expect(screen.getByText('Next')).toBeInTheDocument()
		expect(screen.getByText('Backfill bet')).toBeInTheDocument()
		expect(screen.queryByText(/Not done/)).toBeNull()
	})

	it('adds Not done only when something was not done', () => {
		render(<VoiceSummaryCard summary={{ ...summary, notDone: ['Send the invoice'] }} {...base} />)
		expect(screen.getByText('Not done · 1')).toBeInTheDocument()
		expect(screen.getByText('Send the invoice')).toBeInTheDocument()
	})

	it('asks to read the transcript, and shows it once opened', async () => {
		const onToggle = vi.fn()
		const { rerender } = render(
			<VoiceSummaryCard
				summary={summary}
				{...base}
				onToggleTranscript={onToggle}
				transcript={<p>You: hello</p>}
			/>,
		)
		await userEvent.click(screen.getByRole('button', { name: 'Read transcript' }))
		expect(onToggle).toHaveBeenCalled()
		expect(screen.queryByText('You: hello')).toBeNull()
		rerender(
			<VoiceSummaryCard
				summary={summary}
				{...base}
				transcriptOpen
				transcript={<p>You: hello</p>}
			/>,
		)
		expect(screen.getByText('You: hello')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Hide transcript' })).toBeInTheDocument()
	})

	it('has no transcript button when the call left no transcript', () => {
		render(<VoiceSummaryCard summary={summary} {...base} canReadTranscript={false} />)
		expect(screen.queryByRole('button')).toBeNull()
	})
})
