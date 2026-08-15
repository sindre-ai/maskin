import type { NotificationResponse } from '@/lib/api'
import { NotificationDetailView, NotificationRow } from '@/mcp-apps/notifications/app'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callToolMock = vi.fn()

vi.mock('@/mcp-apps/shared/render', () => ({
	renderMcpApp: vi.fn(),
}))

vi.mock('@/mcp-apps/shared/mcp-app-provider', () => ({
	useCallTool: () => callToolMock,
	useToolResult: () => null,
	useWebAppContext: () => null,
}))

function buildNotification(overrides: Partial<NotificationResponse> = {}): NotificationResponse {
	return {
		id: 'n-1',
		workspaceId: 'ws-1',
		type: 'needs_input',
		title: 'A notification',
		content: null,
		metadata: null,
		sourceActorId: 'actor-1',
		targetActorId: null,
		objectId: null,
		sessionId: null,
		status: 'pending',
		resolvedAt: null,
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

function RowHarness({ initial }: { initial: NotificationResponse }) {
	const [notification, setNotification] = useState(initial)
	return (
		<NotificationRow
			notification={notification}
			onUpdate={(patch) => setNotification((cur) => ({ ...cur, ...patch }))}
			onRemove={() => undefined}
		/>
	)
}

function getRowStatusBadge(container: HTMLElement) {
	// Row has role-agnostic markup; scope by container to avoid ambiguity when
	// multiple badges (type label, timestamp) share the same visual position.
	return within(container).getAllByText(/pending|seen|resolved|dismissed/i)[0]
}

describe('NotificationRow — optimistic-update rollback', () => {
	beforeEach(() => {
		callToolMock.mockReset()
	})

	it('reverts the visible status when update_notification rejects', async () => {
		callToolMock.mockRejectedValueOnce(new Error('network down'))
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		const { container } = render(<RowHarness initial={buildNotification({ status: 'pending' })} />)

		expect(getRowStatusBadge(container)).toHaveTextContent('pending')

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /resolve/i }))
		})

		await waitFor(() => {
			expect(callToolMock).toHaveBeenCalledWith('update_notification', {
				id: 'n-1',
				status: 'resolved',
			})
		})
		await waitFor(() => {
			expect(getRowStatusBadge(container)).toHaveTextContent('pending')
		})
		expect(errorSpy).toHaveBeenCalled()
		errorSpy.mockRestore()
	})

	it('keeps the new status when update_notification resolves', async () => {
		callToolMock.mockResolvedValueOnce({})

		const { container } = render(<RowHarness initial={buildNotification({ status: 'pending' })} />)

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /resolve/i }))
		})

		await waitFor(() => expect(callToolMock).toHaveBeenCalledTimes(1))
		await waitFor(() => {
			expect(getRowStatusBadge(container)).toHaveTextContent('resolved')
		})
	})
})

describe('NotificationDetailView — optimistic-update rollback', () => {
	beforeEach(() => {
		callToolMock.mockReset()
	})

	it('reverts local status and surfaces a failure message on error', async () => {
		callToolMock.mockRejectedValueOnce(new Error('boom'))

		render(<NotificationDetailView notification={buildNotification({ status: 'pending' })} />)

		expect(screen.getByText('pending')).toBeInTheDocument()

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /resolve/i }))
		})

		await waitFor(() => {
			expect(callToolMock).toHaveBeenCalledWith('update_notification', {
				id: 'n-1',
				status: 'resolved',
			})
		})
		await waitFor(() => {
			expect(screen.getByText('pending')).toBeInTheDocument()
		})
		expect(screen.queryByText('resolved')).not.toBeInTheDocument()
		expect(screen.getByText(/Failed:/i)).toBeInTheDocument()
	})

	it('keeps the new status and shows a success message when the tool call resolves', async () => {
		callToolMock.mockResolvedValueOnce({})

		render(<NotificationDetailView notification={buildNotification({ status: 'pending' })} />)

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /resolve/i }))
		})

		await waitFor(() => expect(callToolMock).toHaveBeenCalledTimes(1))
		await waitFor(() => {
			expect(screen.getByText('resolved')).toBeInTheDocument()
		})
		expect(screen.getByText(/Marked resolved/i)).toBeInTheDocument()
	})
})
