import { ObjectFiles } from '@/components/objects/object-files'
import type {
	ActorListItem,
	FileListItem,
	RelationshipResponse,
	UserDisplaySettingsResponse,
} from '@/lib/api'
import { render, screen, waitFor, within } from '@testing-library/react'
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

const useActorsMock = vi.fn()
vi.mock('@/hooks/use-actors', () => ({
	useActors: (...args: unknown[]) => useActorsMock(...args),
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

function buildActor(overrides: Partial<ActorListItem> = {}): ActorListItem {
	return {
		id: 'actor-1',
		type: 'human',
		name: 'Sebk',
		email: null,
		description: null,
		isSystem: false,
		agentState: 'idle',
		...overrides,
	}
}

const baseProps = {
	workspaceId: 'ws-1',
	objectId: 'obj-1',
	objectType: 'bet',
}

function getFileRow(name: string) {
	return screen.getByText(name).closest('a') as HTMLElement
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
		useActorsMock.mockReset()
		useActorsMock.mockReturnValue({ data: [buildActor()] })
	})

	it('renders attached files as inline rows with Size shown by default', () => {
		const file = buildFile()
		useFilesMock.mockReturnValue({ data: [file] })

		render(
			<ObjectFiles
				{...baseProps}
				relationships={{ asSource: [buildAttachedRelationship(file.id)], asTarget: [] }}
			/>,
			{ wrapper: TestWrapper },
		)

		const row = getFileRow('spec.md')
		expect(within(row).getByText('2.0 KB')).toBeInTheDocument()
		expect(within(row).queryByText(/^Created/)).not.toBeInTheDocument()
		expect(within(row).queryByText(/^Modified/)).not.toBeInTheDocument()
	})

	it('toggling Created in the property menu appends Created to the file row in the same session', async () => {
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

		expect(within(getFileRow('spec.md')).queryByText(/^Created/)).not.toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'File properties' }))
		await user.click(screen.getByRole('menuitemcheckbox', { name: /^Created/ }))

		expect(within(getFileRow('spec.md')).getByText(/^Created/)).toBeInTheDocument()
	})

	it('toggling Modified off after on hides the Modified metadata again', async () => {
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
		await user.click(screen.getByRole('menuitemcheckbox', { name: /^Modified/ }))
		expect(within(getFileRow('spec.md')).getByText(/^Modified/)).toBeInTheDocument()

		await user.click(screen.getByRole('menuitemcheckbox', { name: /^Modified/ }))
		expect(within(getFileRow('spec.md')).queryByText(/^Modified/)).not.toBeInTheDocument()
	})

	it('toggling Kind appends the derived kind label to the row', async () => {
		const user = userEvent.setup()
		const file = buildFile({ mimeType: 'application/pdf', name: 'brief.pdf' })
		useFilesMock.mockReturnValue({ data: [file] })

		render(
			<ObjectFiles
				{...baseProps}
				relationships={{ asSource: [buildAttachedRelationship(file.id)], asTarget: [] }}
			/>,
			{ wrapper: TestWrapper },
		)

		await user.click(screen.getByRole('button', { name: 'File properties' }))
		await user.click(screen.getByRole('menuitemcheckbox', { name: /^Kind/ }))

		expect(within(getFileRow('brief.pdf')).getByText('PDF')).toBeInTheDocument()
	})

	it('toggling Uploaded by shows the resolved actor name from useActors', async () => {
		const user = userEvent.setup()
		const file = buildFile({ createdBy: 'actor-42' })
		useFilesMock.mockReturnValue({ data: [file] })
		useActorsMock.mockReturnValue({ data: [buildActor({ id: 'actor-42', name: 'Magnus' })] })

		render(
			<ObjectFiles
				{...baseProps}
				relationships={{ asSource: [buildAttachedRelationship(file.id)], asTarget: [] }}
			/>,
			{ wrapper: TestWrapper },
		)

		await user.click(screen.getByRole('button', { name: 'File properties' }))
		await user.click(screen.getByRole('menuitemcheckbox', { name: /^Uploaded by/ }))

		expect(within(getFileRow('spec.md')).getByText('Magnus')).toBeInTheDocument()
	})

	it('filename is always present and locked in the property menu', async () => {
		const user = userEvent.setup()
		useFilesMock.mockReturnValue({ data: [buildFile()] })

		render(<ObjectFiles {...baseProps} relationships={{ asSource: [], asTarget: [] }} />, {
			wrapper: TestWrapper,
		})

		await user.click(screen.getByRole('button', { name: 'File properties' }))

		const filenameRow = screen.getByRole('menuitemcheckbox', { name: /Filename/ })
		expect(filenameRow).toHaveAttribute('aria-checked', 'true')
		expect(filenameRow).toHaveAttribute('aria-disabled', 'true')
	})

	it('Reset to defaults clears all non-default toggles', async () => {
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
		await user.click(screen.getByRole('menuitemcheckbox', { name: /^Created/ }))
		await user.click(screen.getByRole('menuitemcheckbox', { name: /^Kind/ }))

		const row = getFileRow('spec.md')
		expect(within(row).getByText(/^Created/)).toBeInTheDocument()
		expect(within(row).getByText('Markdown')).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Reset to defaults' }))

		expect(within(getFileRow('spec.md')).queryByText(/^Created/)).not.toBeInTheDocument()
		expect(within(getFileRow('spec.md')).queryByText('Markdown')).not.toBeInTheDocument()
		expect(within(getFileRow('spec.md')).getByText('2.0 KB')).toBeInTheDocument()
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
			expect(within(getFileRow('spec.md')).getByText(/^Created/)).toBeInTheDocument()
		})
		expect(within(getFileRow('spec.md')).getByText(/^Modified/)).toBeInTheDocument()
		expect(useUserDisplaySettingsMock).toHaveBeenCalledWith('ws-1', 'files')
	})

	it('older persisted settings (only created/modified) leave Size at its default-on state', async () => {
		const file = buildFile()
		useFilesMock.mockReturnValue({ data: [file] })
		useUserDisplaySettingsMock.mockReturnValue(
			withPersisted({ created_at: true, modified_at: false }),
		)

		render(
			<ObjectFiles
				{...baseProps}
				relationships={{ asSource: [buildAttachedRelationship(file.id)], asTarget: [] }}
			/>,
			{ wrapper: TestWrapper },
		)

		await waitFor(() => {
			expect(within(getFileRow('spec.md')).getByText(/^Created/)).toBeInTheDocument()
		})
		expect(within(getFileRow('spec.md')).getByText('2.0 KB')).toBeInTheDocument()
	})

	it('falls back to defaults (Size on, others off) when no persisted settings exist', async () => {
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

		const row = getFileRow('spec.md')
		expect(within(row).getByText('2.0 KB')).toBeInTheDocument()
		expect(within(row).queryByText(/^Created/)).not.toBeInTheDocument()
		expect(within(row).queryByText(/^Modified/)).not.toBeInTheDocument()
	})

	it('debounces a write-through to upsert under object_type "files" when a property is toggled', async () => {
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
		await user.click(screen.getByRole('menuitemcheckbox', { name: /^Created/ }))

		await waitFor(() => {
			expect(updateMutateMock).toHaveBeenCalledWith({
				objectType: 'files',
				settings: {
					columnVisibility: {
						size: true,
						created_at: true,
						modified_at: false,
						kind: false,
						uploaded_by: false,
					},
				},
			})
		})
	})

	it('does not write through before the persisted-settings query has resolved', async () => {
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
		await user.click(screen.getByRole('menuitemcheckbox', { name: /^Created/ }))

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
		await user.click(screen.getByRole('menuitemcheckbox', { name: /^Created/ }))

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
		await user.click(screen.getByRole('menuitemcheckbox', { name: /^Modified/ }))
		await user.click(screen.getByRole('menuitemcheckbox', { name: /^Modified/ }))

		expect(trackEventMock).toHaveBeenNthCalledWith(1, 'files_display_property_toggled', {
			property: 'modified_at',
			enabled: true,
		})
		expect(trackEventMock).toHaveBeenNthCalledWith(2, 'files_display_property_toggled', {
			property: 'modified_at',
			enabled: false,
		})
	})

	it('emits files_display_property_toggled with enabled=false when turning Size off', async () => {
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
		await user.click(screen.getByRole('menuitemcheckbox', { name: /^Size/ }))

		expect(trackEventMock).toHaveBeenCalledWith('files_display_property_toggled', {
			property: 'size',
			enabled: false,
		})
		expect(within(getFileRow('spec.md')).queryByText('2.0 KB')).not.toBeInTheDocument()
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
			expect(within(getFileRow('spec.md')).getByText(/^Created/)).toBeInTheDocument()
		})
		expect(trackEventMock).not.toHaveBeenCalled()
	})
})

describe('ObjectFiles — endpoint resolution by id', () => {
	beforeEach(() => {
		useFilesMock.mockReset()
		useFileMock.mockReset()
		useFileMock.mockReturnValue({ data: undefined })
		useUserDisplaySettingsMock.mockReset()
		useUserDisplaySettingsMock.mockReturnValue(noPersistedSettings())
		updateMutateMock.mockReset()
		trackEventMock.mockReset()
		useActorsMock.mockReset()
		useActorsMock.mockReturnValue({ data: [buildActor()] })
	})

	it('collects a candidate id from an attached edge stamped with the canonical `file` label', () => {
		const rel: RelationshipResponse = {
			id: 'rel-1',
			sourceType: 'object',
			sourceId: 'obj-1',
			targetType: 'file',
			targetId: 'file-1',
			type: 'attached',
			createdBy: 'actor-1',
			createdAt: null,
		}
		useFilesMock.mockReturnValue({ data: [buildFile({ id: 'file-1', name: 'canonical.png' })] })

		render(<ObjectFiles {...baseProps} relationships={{ asSource: [rel], asTarget: [] }} />, {
			wrapper: TestWrapper,
		})

		expect(useFilesMock).toHaveBeenCalledWith('ws-1', { ids: ['file-1'] })
	})

	it('collects a candidate id from an attached edge stamped with a legacy non-`file` label', () => {
		// Bet-creation used to stamp `targetType` with the endpoint's specialised
		// type even when the endpoint was a file — the read path must not filter
		// by label. The id is what matters.
		const rel: RelationshipResponse = {
			id: 'rel-legacy',
			sourceType: 'object',
			sourceId: 'obj-1',
			targetType: 'bet',
			targetId: 'file-1',
			type: 'attached',
			createdBy: 'actor-1',
			createdAt: null,
		}
		useFilesMock.mockReturnValue({ data: [buildFile({ id: 'file-1', name: 'legacy.png' })] })

		render(<ObjectFiles {...baseProps} relationships={{ asSource: [rel], asTarget: [] }} />, {
			wrapper: TestWrapper,
		})

		expect(useFilesMock).toHaveBeenCalledWith('ws-1', { ids: ['file-1'] })
	})

	it('collects a candidate id when the file endpoint appears as the edge source (asTarget)', () => {
		const rel: RelationshipResponse = {
			id: 'rel-inbound',
			sourceType: 'file',
			sourceId: 'file-2',
			targetType: 'object',
			targetId: 'obj-1',
			type: 'attached',
			createdBy: 'actor-1',
			createdAt: null,
		}
		useFilesMock.mockReturnValue({ data: [buildFile({ id: 'file-2', name: 'inbound.png' })] })

		render(<ObjectFiles {...baseProps} relationships={{ asSource: [], asTarget: [rel] }} />, {
			wrapper: TestWrapper,
		})

		expect(useFilesMock).toHaveBeenCalledWith('ws-1', { ids: ['file-2'] })
	})

	it('ignores non-attached relationships regardless of their labels', () => {
		const informs: RelationshipResponse = {
			id: 'rel-informs',
			sourceType: 'object',
			sourceId: 'obj-1',
			targetType: 'object',
			targetId: 'obj-2',
			type: 'informs',
			createdBy: 'actor-1',
			createdAt: null,
		}
		useFilesMock.mockReturnValue({ data: [] })

		render(<ObjectFiles {...baseProps} relationships={{ asSource: [informs], asTarget: [] }} />, {
			wrapper: TestWrapper,
		})

		expect(useFilesMock).toHaveBeenCalledWith('ws-1', { ids: [] })
	})
})
