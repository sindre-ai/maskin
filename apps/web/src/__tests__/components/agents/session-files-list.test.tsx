import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		sessions: {
			files: vi.fn(),
			downloadFile: vi.fn(),
		},
	},
}))

const downloadBlobMock = vi.fn()
vi.mock('@/lib/download', () => ({
	downloadBlob: (blob: Blob, filename: string) => downloadBlobMock(blob, filename),
}))

import { SessionFilesList } from '@/components/agents/session-files-list'
import { api } from '@/lib/api'
import { TestWrapper } from '../../setup'

const sessionId = 'session-1'
const workspaceId = 'ws-1'

beforeEach(() => {
	vi.clearAllMocks()
})

describe('SessionFilesList', () => {
	it('shows the empty state when there are no files', async () => {
		vi.mocked(api.sessions.files).mockResolvedValue({ files: [] })

		render(
			<TestWrapper>
				<SessionFilesList sessionId={sessionId} workspaceId={workspaceId} />
			</TestWrapper>,
		)

		await waitFor(() => expect(screen.getByText('No files')).toBeInTheDocument())
	})

	it('renders one row per file with formatted size', async () => {
		vi.mocked(api.sessions.files).mockResolvedValue({
			files: [
				{ path: 'index.html', size_bytes: 1024 },
				{ path: 'assets/style.css', size_bytes: 256 },
			],
		})

		render(
			<TestWrapper>
				<SessionFilesList sessionId={sessionId} workspaceId={workspaceId} />
			</TestWrapper>,
		)

		expect(await screen.findByText('index.html')).toBeInTheDocument()
		expect(screen.getByText('assets/style.css')).toBeInTheDocument()
		expect(screen.getByText('1 KB')).toBeInTheDocument()
		expect(screen.getByText('256 B')).toBeInTheDocument()
	})

	it('downloads the file when the button is clicked', async () => {
		vi.mocked(api.sessions.files).mockResolvedValue({
			files: [{ path: 'assets/style.css', size_bytes: 16 }],
		})
		const blob = new Blob(['body { color: red; }'], { type: 'text/css' })
		vi.mocked(api.sessions.downloadFile).mockResolvedValue(blob)

		render(
			<TestWrapper>
				<SessionFilesList sessionId={sessionId} workspaceId={workspaceId} />
			</TestWrapper>,
		)

		const button = await screen.findByRole('button', { name: /download assets\/style\.css/i })
		fireEvent.click(button)

		await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1))
		expect(api.sessions.downloadFile).toHaveBeenCalledWith(
			sessionId,
			'assets/style.css',
			workspaceId,
		)
		expect(downloadBlobMock).toHaveBeenCalledWith(blob, 'style.css')
	})
})
