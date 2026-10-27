import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { VoiceTranscriptView } from '@/components/chat/voice-transcript-view'

const lines = [
	{ id: 1, t: 0, speaker: 'You', text: 'Could you check the cancel flow?' },
	{ id: 2, t: 18, speaker: 'Developer', text: 'The fix is one generic rule.' },
	{ id: 3, t: 3604, speaker: 'Developer', text: 'Notes are above.' },
]

describe('VoiceTranscriptView', () => {
	it('shows one row per line with time, speaker and text', () => {
		render(
			<VoiceTranscriptView open onOpenChange={() => {}} lines={lines} durationSeconds={3604} />,
		)
		expect(screen.getByRole('dialog', { name: 'Transcript' })).toBeInTheDocument()
		expect(screen.getAllByRole('listitem')).toHaveLength(3)
		expect(screen.getByText('0:00')).toBeInTheDocument()
		expect(screen.getByText('0:18')).toBeInTheDocument()
		expect(screen.getByText('1:00:04', { selector: 'span.font-mono' })).toBeInTheDocument()
		expect(screen.getByText('You')).toBeInTheDocument()
		expect(screen.getAllByText('Developer')).toHaveLength(2)
		expect(screen.getByText('The fix is one generic rule.')).toBeInTheDocument()
	})

	it('says how long the call was and how many lines it has', () => {
		render(
			<VoiceTranscriptView open onOpenChange={() => {}} lines={lines} durationSeconds={3604} />,
		)
		expect(screen.getByText('1:00:04 · 3 lines')).toBeInTheDocument()
	})

	it('says plainly when no lines were saved', () => {
		render(<VoiceTranscriptView open onOpenChange={() => {}} lines={[]} />)
		expect(screen.getByText('No spoken lines were saved for this call.')).toBeInTheDocument()
	})

	it('renders nothing while closed', () => {
		render(<VoiceTranscriptView open={false} onOpenChange={() => {}} lines={lines} />)
		expect(screen.queryByRole('dialog')).toBeNull()
	})
})
