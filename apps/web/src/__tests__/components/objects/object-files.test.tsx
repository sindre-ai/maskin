import { ObjectFiles } from '@/components/objects/object-files'
import type { FileListItem, RelationshipResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const useFileMock = vi.fn()
const useFilesMock = vi.fn()
const createFileMock = vi.fn()
vi.mock('@/hooks/use-files', () => ({
	useFile: (...args: unknown[]) => useFileMock(...args),
	useFiles: (...args: unknown[]) => useFilesMock(...args),
	useCreateFile: () => ({ mutateAsync: createFileMock }),
}))

const createRelationshipMock = vi.fn()
vi.mock('@/hooks/use-relationships', () => ({
	useCreateRelationship: () => ({ mutateAsync: createRelationshipMock }),
}))

function buildFile(overrides: Partial<FileListItem> = {}): FileListItem {
	return {
		id: 'file-1',
		workspaceId: 'ws-1',
		name: 'spec.md',
		description: null,
		mimeType: 'text/markdown',
		sizeBytes: 2048,
		storageKey: 'workspaces/ws-1/files/file-1',
		createdBy: 'actor-1',
		createdAt: '2026-06-10T10:00:00.000Z',
		updatedAt: '2026-06-15T10:00:00.000Z',
		...overrides,
	}
}

function buildAttachedRelationship(fileId: string): RelationshipResponse {
	return {
		id: `rel-${fileId}`,
		sourceType: 'bet',
		sourceId: 'obj-1',
		targetType: 'file',
		targetId: fileId,
		type: 'attached',
		createdBy: 'actor-1',
		createdAt: '2026-06-10T10:00:00.000Z',
	}
}

const baseProps = {
	workspaceId: 'ws-1',
	objectId: 'obj-1',
	objectType: 'bet',
}

describe('ObjectFiles', () => {
	beforeEach(() => {
		useFilesMock.mockReset()
		useFileMock.mockReset()
		useFileMock.mockReturnValue({ data: undefined })
	})

	it('renders attached files in a table with Name + Size by default', () => {
		const file = buildFile()
		useFilesMock.mockReturnValue({ data: [file] })

		render(
			<ObjectFiles
				{...baseProps}
				relationships={{ asSource: [buildAttachedRelationship(file.id)], asTarget: [] }}
			/>,
			{ wrapper: TestWrapper },
		)

		expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument()
		expect(screen.getByRole('columnheader', { name: 'Size' })).toBeInTheDocument()
		expect(screen.queryByRole('columnheader', { name: 'Created' })).not.toBeInTheDocument()
		expect(screen.queryByRole('columnheader', { name: 'Modified' })).not.toBeInTheDocument()
		expect(screen.getByText('spec.md')).toBeInTheDocument()
	})

	it('toggling Created in the property menu shows the Created column for files in the same session', async () => {
		const user = userEvent.setup()
		const file = buildFile()
		useFilesMock.mockReturnValue({ data: [file] })

		render(
			<ObjectFiles
				{...baseProps}
				relationships={{ asSource: [buildAttachedRelationship(file.id)], asTarget: [] }}
			/>,
			{ wrapper: TestWrapper },
		)

		expect(screen.queryByRole('columnheader', { name: 'Created' })).not.toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'File properties' }))
		await user.click(screen.getByRole('menuitemcheckbox', { name: 'Created' }))

		expect(screen.getByRole('columnheader', { name: 'Created' })).toBeInTheDocument()
	})

	it('toggling Modified off after on hides the Modified column again', async () => {
		const user = userEvent.setup()
		const file = buildFile()
		useFilesMock.mockReturnValue({ data: [file] })

		render(
			<ObjectFiles
				{...baseProps}
				relationships={{ asSource: [buildAttachedRelationship(file.id)], asTarget: [] }}
			/>,
			{ wrapper: TestWrapper },
		)

		await user.click(screen.getByRole('button', { name: 'File properties' }))
		await user.click(screen.getByRole('menuitemcheckbox', { name: 'Modified' }))
		expect(screen.getByRole('columnheader', { name: 'Modified' })).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'File properties' }))
		await user.click(screen.getByRole('menuitemcheckbox', { name: 'Modified' }))
		expect(screen.queryByRole('columnheader', { name: 'Modified' })).not.toBeInTheDocument()
	})

	it('shows the empty-state uploader when no files are attached', () => {
		useFilesMock.mockReturnValue({ data: [] })

		render(<ObjectFiles {...baseProps} relationships={{ asSource: [], asTarget: [] }} />, {
			wrapper: TestWrapper,
		})

		expect(screen.getByText('Drop a file here or click to upload')).toBeInTheDocument()
	})
})
