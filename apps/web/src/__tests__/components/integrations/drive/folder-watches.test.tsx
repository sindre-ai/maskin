import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildDriveWatch } from '../../../factories'

const mockWatches = vi.fn()
const mockStop = vi.fn()
const mockRefetch = vi.fn()
const stopState = { isPending: false, variables: undefined as string | undefined }

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@/hooks/use-integrations', () => ({
	useDriveWatches: () => mockWatches(),
	useStopDriveWatch: () => ({ mutate: mockStop, ...stopState }),
}))

import { FolderWatches } from '@/components/integrations/drive/folder-watches'

const nameForAccount = (account: string) => (account.startsWith('priya') ? 'Priya Shah' : 'Kai Ono')

function setWatches(data: ReturnType<typeof buildDriveWatch>[]) {
	mockWatches.mockReturnValue({ data, isLoading: false, isError: false, refetch: mockRefetch })
}

describe('FolderWatches', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		stopState.isPending = false
		stopState.variables = undefined
	})

	it('renders one row per seeded watch in the folder-row format', () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-10-05T12:00:00.000Z'))
		setWatches([
			buildDriveWatch({
				folderId: 'f-rec',
				name: 'Meet Recordings',
				account: 'priya@acme.test',
				triggers: [{ id: 't-1', name: 'Post-call recap' }],
				lastFiredAt: '2026-10-05T10:00:00.000Z',
			}),
			buildDriveWatch({ folderId: 'f-brief', name: 'Customer briefs', account: 'kai@acme.test' }),
		])
		render(<FolderWatches nameForAccount={nameForAccount} />)
		vi.useRealTimers()

		expect(screen.getByRole('heading', { name: 'Folder watches' })).toBeInTheDocument()
		const rows = within(screen.getByTestId('folder-watch-list')).getAllByRole('listitem')
		expect(rows).toHaveLength(2)

		const rec = screen.getByTestId('folder-watch-f-rec')
		expect(
			within(rec).getByText('Meet Recordings', { selector: 'span.sr-only' }),
		).toBeInTheDocument()
		expect(within(rec).getByTestId('folder-watch-meta')).toHaveTextContent(
			'Priya Shah · triggers Post-call recap · last fired 2h ago',
		)
		expect(within(rec).getByTestId('mcp-tag-on-drive')).toHaveTextContent(
			'google_drive.watch_folder',
		)
	})

	it('omits the triggers and last fired segments when nothing sources them', () => {
		setWatches([buildDriveWatch({ folderId: 'f-bare', account: 'kai@acme.test' })])
		render(<FolderWatches nameForAccount={nameForAccount} />)
		const meta = within(screen.getByTestId('folder-watch-f-bare')).getByTestId('folder-watch-meta')
		expect(meta).toHaveTextContent(/^Kai Ono$/)
	})

	it('drops the meta line entirely when the watch has no account, trigger or fire time', () => {
		setWatches([buildDriveWatch({ folderId: 'f-none', account: null })])
		render(<FolderWatches nameForAccount={nameForAccount} />)
		expect(screen.queryByTestId('folder-watch-meta')).not.toBeInTheDocument()
	})

	it('shortens a long path at a folder boundary and keeps the full path accessible', () => {
		const path = 'My Drive/Customers/Acme Studio/Quarterly business reviews/2026/Board materials'
		setWatches([buildDriveWatch({ folderId: 'f-long', name: 'Q3 briefs', path })])
		render(<FolderWatches nameForAccount={nameForAccount} />)

		const full = `${path}/Q3 briefs`
		const row = screen.getByTestId('folder-watch-f-long')
		const shown = row.querySelector('[aria-hidden="true"]:not(svg)')
		expect(shown?.textContent).toBe('…/Quarterly business reviews/2026/Board materials/Q3 briefs')
		expect(within(row).getByText(full, { selector: 'span.sr-only' })).toBeInTheDocument()
		expect(row.querySelector('p[title]')?.getAttribute('title')).toBe(full)
	})

	it('gives Stop an accessible name that includes the folder and stops that folder', async () => {
		setWatches([
			buildDriveWatch({ folderId: 'f-a', name: 'Meet Recordings' }),
			buildDriveWatch({ folderId: 'f-b', name: 'Customer briefs' }),
		])
		render(<FolderWatches nameForAccount={nameForAccount} />)

		const stop = screen.getByRole('button', { name: 'Stop watch for Customer briefs' })
		expect(stop).toHaveTextContent('Stop watch')
		await userEvent.click(stop)
		expect(mockStop).toHaveBeenCalledWith('f-b')
		expect(mockStop).toHaveBeenCalledTimes(1)
	})

	it('disables only the Stop button of the folder being stopped', () => {
		stopState.isPending = true
		stopState.variables = 'f-a'
		setWatches([
			buildDriveWatch({ folderId: 'f-a', name: 'Meet Recordings' }),
			buildDriveWatch({ folderId: 'f-b', name: 'Customer briefs' }),
		])
		render(<FolderWatches nameForAccount={nameForAccount} />)
		expect(screen.getByRole('button', { name: 'Stop watch for Meet Recordings' })).toBeDisabled()
		expect(screen.getByRole('button', { name: 'Stop watch for Customer briefs' })).toBeEnabled()
	})

	it('has no add-a-watch control', () => {
		setWatches([buildDriveWatch()])
		render(<FolderWatches nameForAccount={nameForAccount} />)
		expect(screen.queryByRole('button', { name: /add|new|create/i })).not.toBeInTheDocument()
	})

	it('shows an empty state, not a blank card or fake rows, when nothing is watched', () => {
		setWatches([])
		render(<FolderWatches nameForAccount={nameForAccount} />)
		expect(screen.getByText('No folders are being watched')).toBeInTheDocument()
		expect(screen.getByTestId('folder-watches-empty')).toBeInTheDocument()
		expect(screen.queryByTestId('folder-watch-list')).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /stop watch/i })).not.toBeInTheDocument()
	})

	it('shows a skeleton while loading', () => {
		mockWatches.mockReturnValue({ data: undefined, isLoading: true, isError: false })
		render(<FolderWatches nameForAccount={nameForAccount} />)
		expect(screen.getByTestId('folder-watches-loading')).toBeInTheDocument()
		expect(screen.queryByTestId('folder-watches-empty')).not.toBeInTheDocument()
	})

	it('shows an error with a retry, not the empty state, when the list fails to load', async () => {
		mockWatches.mockReturnValue({
			data: undefined,
			isLoading: false,
			isError: true,
			refetch: mockRefetch,
		})
		render(<FolderWatches nameForAccount={nameForAccount} />)
		expect(screen.getByRole('alert')).toHaveTextContent('Could not load folder watches')
		expect(screen.queryByTestId('folder-watches-empty')).not.toBeInTheDocument()
		await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
		expect(mockRefetch).toHaveBeenCalled()
	})
})
