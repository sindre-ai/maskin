import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const retryMutate = vi.fn()
vi.mock('@/hooks/use-conversation', () => ({
	useRetryMessage: () => ({ mutate: retryMutate, isPending: false }),
}))

import { FailedTurnNotice, isPermanentFailure } from '@/components/chat/failed-turn-notice'
import type { MessageResponse } from '@/lib/api'

const failed = (final_output: Record<string, unknown>): MessageResponse =>
	({
		id: 42,
		conversationId: 'conv-1',
		actorId: 'agent-1',
		actorType: 'agent',
		kind: 'message',
		content: 'Maskin could not run this. Nothing was created.',
		metadata: {
			source: 'final_output',
			final_output: { dedupe_key: 'k', is_error: true, ...final_output },
		},
	}) as unknown as MessageResponse

const renderNotice = (message: MessageResponse, onRetried = vi.fn()) =>
	render(
		<TestWrapper>
			<FailedTurnNotice message={message} workspaceId="ws-1" onRetried={onRetried} />
		</TestWrapper>,
	)

describe('FailedTurnNotice', () => {
	beforeEach(() => vi.clearAllMocks())

	const permanent = failed({
		error_kind: 'permanent',
		message_id: 41,
		error_detail: '402 Payment Required: can only afford 4882 tokens',
	})

	it('keeps the raw error behind a Details fold that starts closed', () => {
		const { container } = renderNotice(permanent)

		const fold = container.querySelector('details')
		expect(fold).not.toBeNull()
		expect(fold?.open).toBe(false)
		expect(screen.getByText('Details')).toBeInTheDocument()
		expect(screen.getByText(/402 Payment Required/)).toBeInTheDocument()
	})

	it('has no fold when no raw text was kept', () => {
		const { container } = renderNotice(failed({ error_kind: 'permanent' }))

		expect(container.querySelector('details')).toBeNull()
		expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
	})

	it("Retry asks the same agent to answer the person's message again", async () => {
		const onRetried = vi.fn()
		renderNotice(permanent, onRetried)

		await userEvent.click(screen.getByRole('button', { name: 'Retry' }))

		expect(retryMutate).toHaveBeenCalledWith(
			{ messageId: 41, agentId: 'agent-1' },
			expect.objectContaining({ onSuccess: expect.any(Function) }),
		)
		retryMutate.mock.calls[0]?.[1].onSuccess()
		expect(onRetried).toHaveBeenCalledWith(permanent)
	})
})

describe('isPermanentFailure', () => {
	it('is true only for a permanent failure notice', () => {
		expect(isPermanentFailure(failed({ error_kind: 'permanent' }))).toBe(true)
		expect(isPermanentFailure(failed({ error_kind: 'transient' }))).toBe(false)
		expect(isPermanentFailure(failed({ retry: 'unanswered' }))).toBe(false)
	})
})
