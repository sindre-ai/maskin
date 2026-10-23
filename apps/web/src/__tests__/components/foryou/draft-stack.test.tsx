import { DraftStack } from '@/components/foryou/draft-stack'
import type { LatestMentionDecisionDraft } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const DRAFTS: LatestMentionDecisionDraft[] = [
	{
		id: 'kenneth',
		label: 'LinkedIn DM',
		to: 'Kenneth Krog Madsen',
		body: 'Hej Kenneth, tak for sidst.',
	},
	{ id: 'dan', label: 'Connection note', to: 'Dan Højgaard Jensen', body: 'Hej Dan.' },
]

function setup(onAction = vi.fn().mockResolvedValue(undefined)) {
	const onAllDone = vi.fn()
	render(
		<DraftStack workspaceId="ws-1" drafts={DRAFTS} onAction={onAction} onAllDone={onAllDone} />,
	)
	return { onAction, onAllDone }
}

describe('DraftStack', () => {
	it('shows every message with its recipient and text', () => {
		setup()
		expect(screen.getByText('Hej Kenneth, tak for sidst.')).toBeInTheDocument()
		expect(screen.getByText('Hej Dan.')).toBeInTheDocument()
		expect(screen.getByText('To Kenneth Krog Madsen')).toBeInTheDocument()
		expect(screen.getAllByRole('button', { name: 'Send' })).toHaveLength(2)
		expect(screen.getAllByRole('button', { name: 'Skip' })).toHaveLength(2)
	})

	it('asks for a second tap before anything is sent', async () => {
		const { onAction } = setup()
		await userEvent.click(screen.getAllByRole('button', { name: 'Send' })[0])
		expect(onAction).not.toHaveBeenCalled()
		await userEvent.click(
			screen.getByRole('button', { name: 'Confirm send to Kenneth Krog Madsen' }),
		)
		expect(onAction).toHaveBeenCalledWith(DRAFTS[0], 'send')
	})

	it('cancels a send without telling the agent', async () => {
		const { onAction } = setup()
		await userEvent.click(screen.getAllByRole('button', { name: 'Send' })[0])
		await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
		expect(onAction).not.toHaveBeenCalled()
		expect(screen.getAllByRole('button', { name: 'Send' })).toHaveLength(2)
	})

	it('skips one message on one tap and folds it to a receipt, leaving the other open', async () => {
		const { onAction } = setup()
		await userEvent.click(screen.getAllByRole('button', { name: 'Skip' })[1])
		expect(onAction).toHaveBeenCalledWith(DRAFTS[1], 'skip')
		expect(await screen.findByText(/Skipped · Dan Højgaard Jensen/)).toBeInTheDocument()
		expect(screen.queryByText('Hej Dan.')).not.toBeInTheDocument()
		expect(screen.getByText('Hej Kenneth, tak for sidst.')).toBeInTheDocument()
	})

	it('settles the card only after the last message has been dealt with', async () => {
		const { onAllDone } = setup()
		await userEvent.click(screen.getAllByRole('button', { name: 'Skip' })[0])
		expect(onAllDone).not.toHaveBeenCalled()
		await userEvent.click(await screen.findByRole('button', { name: 'Skip' }))
		await screen.findByText(/Skipped · Dan Højgaard Jensen/)
		expect(onAllDone).toHaveBeenCalledTimes(1)
	})

	it('keeps a message open and says so when the reply could not be sent', async () => {
		const { onAllDone } = setup(vi.fn().mockRejectedValue(new Error('offline')))
		await userEvent.click(screen.getAllByRole('button', { name: 'Skip' })[0])
		expect(await screen.findByRole('alert')).toHaveTextContent('Could not send your reply')
		expect(screen.getByText('Hej Kenneth, tak for sidst.')).toBeInTheDocument()
		expect(onAllDone).not.toHaveBeenCalled()
	})
})
