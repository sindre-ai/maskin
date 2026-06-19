import { ObjectFiles } from '@/components/objects/object-files'
import type { FileListItem, RelationshipResponse, UserDisplaySettingsResponse } from '@/lib/api'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const trackEventMock = vi.fn()
vi.mock('@/lib/analytics', () => ({
	trackEvent: (...args: unknown[]) => trackEventMock(...args),
}))

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

const useUserDisplaySettingsMock = vi.fn()
const updateMutateMock = vi.fn()
vi.mock('@/hooks/use-user-display-settings', () => ({
	useUserDisplaySettings: (...args: unknown[]) => useUserDisplaySettingsMock(...args),
	useUpdateUserDisplaySettings: () => ({ mutate: updateMutateMock }),
}))

function persistedSettings(columnVisibility: Record<string, boolean>): UserDisplaySettingsResponse {
	return {
		object_type: 'files',
		name: 'default',
		settings: { columnVisibility },
		updated_at: '2026-06-19T10:00:00.000Z',
	}
}

function noPersistedSettings() {
	return { isSuccess: true, data: null }
}

function withPersisted(columnVisibility: Record<string, boolean>) {
	return { isSuccess: true, data: persistedSettings(columnVisibility) }
}

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
		useUserDisplaySettingsMock.mockReset()
		useUserDisplaySettingsMock.mockReturnValue(noPersistedSettings())
		updateMutateMock.mockReset()
		trackEventMock.mockReset()
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

	it('rehydrates Created/Modified visibility from persisted settings under object_type "files"', async () => {
		const file = buildFile()
		useFilesMock.mockReturnValue({ data: [file] })
		useUserDisplaySettingsMock.mockReturnValue(
			withPersisted({ created_at: true, modified_at: true }),
		)

		render(
			<ObjectFiles
				{...baseProps}
				relationships={{ asSource: [buildAttachedRelationship(file.id)], asTarget: [] }}
			/>,
			{ wrapper: TestWrapper },
		)

		await waitFor(() => {
			expect(screen.getByRole('columnheader', { name: 'Created' })).toBeInTheDocument()
		})
		expect(screen.getByRole('columnheader', { name: 'Modified' })).toBeInTheDocument()
		expect(useUserDisplaySettingsMock).toHaveBeenCalledWith('ws-1', 'files')
	})

	it('falls back to default-OFF columns when no persisted settings exist', async () => {
		const file = buildFile()
		useFilesMock.mockReturnValue({ data: [file] })
		useUserDisplaySettingsMock.mockReturnValue(noPersistedSettings())

		render(
			<ObjectFiles
				{...baseProps}
				relationships={{ asSource: [buildAttachedRelationship(file.id)], asTarget: [] }}
			/>,
			{ wrapper: TestWrapper },
		)

		expect(screen.queryByRole('columnheader', { name: 'Created' })).not.toBeInTheDocument()
		expect(screen.queryByRole('columnheader', { name: 'Modified' })).not.toBeInTheDocument()
	})

	it('debounces a write-through to upsert under object_type "files" when a column is toggled', async () => {
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
		await user.click(screen.getByRole('menuitemcheckbox', { name: 'Created' }))

		await waitFor(() => {
			expect(updateMutateMock).toHaveBeenCalledWith({
				objectType: 'files',
				settings: { columnVisibility: { created_at: true, modified_at: false } },
			})
		})
	})

	it('does not write through before the persisted-settings query has resolved', async () => {
		// Loading state — no row yet, query still pending. Toggling should not
		// trigger an upsert until hydration finishes; otherwise the user's
		// transient state would overwrite a not-yet-loaded saved view.
		useUserDisplaySettingsMock.mockReturnValue({ isSuccess: false, data: undefined })
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
		await user.click(screen.getByRole('menuitemcheckbox', { name: 'Created' }))

		// Wait long enough that any debounced write would have fired (>500ms).
		await new Promise((resolve) => setTimeout(resolve, 700))
		expect(updateMutateMock).not.toHaveBeenCalled()
	})

	it('emits files_display_property_toggled with property + enabled=true on toggle-on', async () => {
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
		await user.click(screen.getByRole('menuitemcheckbox', { name: 'Created' }))

		expect(trackEventMock).toHaveBeenCalledWith('files_display_property_toggled', {
			property: 'created_at',
			enabled: true,
		})
	})

	it('emits files_display_property_toggled with enabled=false on toggle-off', async () => {
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
		await user.click(screen.getByRole('button', { name: 'File properties' }))
		await user.click(screen.getByRole('menuitemcheckbox', { name: 'Modified' }))

		expect(trackEventMock).toHaveBeenNthCalledWith(1, 'files_display_property_toggled', {
			property: 'modified_at',
			enabled: true,
		})
		expect(trackEventMock).toHaveBeenNthCalledWith(2, 'files_display_property_toggled', {
			property: 'modified_at',
			enabled: false,
		})
	})

	it('does not emit files_display_property_toggled when hydrating from persisted settings', async () => {
		const file = buildFile()
		useFilesMock.mockReturnValue({ data: [file] })
		useUserDisplaySettingsMock.mockReturnValue(
			withPersisted({ created_at: true, modified_at: true }),
		)

		render(
			<ObjectFiles
				{...baseProps}
				relationships={{ asSource: [buildAttachedRelationship(file.id)], asTarget: [] }}
			/>,
			{ wrapper: TestWrapper },
		)

		await waitFor(() => {
			expect(screen.getByRole('columnheader', { name: 'Created' })).toBeInTheDocument()
		})
		expect(trackEventMock).not.toHaveBeenCalled()
	})
})
