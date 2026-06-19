import { ObjectFiles } from '@/components/objects/object-files'
import type { FileListItem, RelationshipResponse, UserDisplaySettingsResponse } from '@/lib/api'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/api', () => ({
	api: {
		files: {
			list: vi.fn(),
			get: vi.fn(),
			create: vi.fn(),
			createWithProgress: vi.fn(),
			update: vi.fn(),
		},
		relationships: {
			create: vi.fn(),
		},
	},
}))

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

const useUserDisplaySettingsMock = vi.fn()
const updateMutateMock = vi.fn()
vi.mock('@/hooks/use-user-display-settings', () => ({
	useUserDisplaySettings: (...args: unknown[]) => useUserDisplaySettingsMock(...args),
	useUpdateUserDisplaySettings: () => ({ mutate: updateMutateMock }),
}))

import { api } from '@/lib/api'

function buildRel(overrides: Partial<RelationshipResponse> = {}): RelationshipResponse {
	return {
		id: `rel-${Math.random().toString(36).slice(2)}`,
		sourceType: 'object',
		sourceId: 'obj-1',
		targetType: 'file',
		targetId: 'file-1',
		type: 'attached',
		createdBy: 'actor-1',
		createdAt: null,
		...overrides,
	}
}

function buildFileItem(overrides: Partial<FileListItem> = {}): FileListItem {
	return {
		id: 'file-1',
		workspaceId: 'ws-1',
		name: 'diagram.png',
		description: null,
		mimeType: 'image/png',
		sizeBytes: 4096,
		storageKey: 'workspaces/ws-1/files/file-1',
		createdBy: 'actor-1',
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
		...overrides,
	}
}

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

const baseProps = {
	workspaceId: 'ws-1',
	objectId: 'obj-1',
	objectType: 'bet',
}

beforeEach(() => {
	vi.clearAllMocks()
	useUserDisplaySettingsMock.mockReturnValue(noPersistedSettings())
})

describe('ObjectFiles — endpoint resolution by id', () => {
	it('renders an attached file whose edge is stamped with the canonical `file` label', async () => {
		const rel = buildRel({
			sourceType: 'object',
			sourceId: 'obj-1',
			targetType: 'file',
			targetId: 'file-1',
			type: 'attached',
		})
		const file = buildFileItem({ id: 'file-1', name: 'canonical.png' })
		vi.mocked(api.files.list).mockResolvedValue([file])

		const { findByText } = render(
			<TestWrapper>
				<ObjectFiles
					{...baseProps}
					relationships={{ asSource: [rel], asTarget: [] }}
				/>
			</TestWrapper>,
		)

		await findByText('canonical.png')
		expect(api.files.list).toHaveBeenCalledWith('ws-1', { ids: ['file-1'] })
	})

	it('renders an attached file whose edge is stamped with a legacy non-`file` label', async () => {
		// Bet-creation stamps `sourceType` with the endpoint's specialised type
		// even when the endpoint is a file — a legacy pattern the write path is
		// being normalised away in a sibling task. The read layer must still
		// surface the attachment, driven by the endpoint id, not the label.
		const rel = buildRel({
			sourceType: 'object',
			sourceId: 'obj-1',
			targetType: 'bet', // legacy mislabel — endpoint is actually a file
			targetId: 'file-1',
			type: 'attached',
		})
		const file = buildFileItem({ id: 'file-1', name: 'legacy.png' })
		vi.mocked(api.files.list).mockResolvedValue([file])

		const { findByText } = render(
			<TestWrapper>
				<ObjectFiles
					{...baseProps}
					relationships={{ asSource: [rel], asTarget: [] }}
				/>
			</TestWrapper>,
		)

		// The candidate id list is sent to the server; the server-side files
		// query self-filters non-files, so we don't need to gate on the label.
		await findByText('legacy.png')
		expect(api.files.list).toHaveBeenCalledWith('ws-1', { ids: ['file-1'] })
	})

	it('resolves a file endpoint that appears as the edge source (asTarget)', async () => {
		const rel = buildRel({
			id: 'rel-inbound',
			sourceType: 'file', // canonical
			sourceId: 'file-2',
			targetType: 'object',
			targetId: 'obj-1',
			type: 'attached',
		})
		const file = buildFileItem({ id: 'file-2', name: 'inbound.png' })
		vi.mocked(api.files.list).mockResolvedValue([file])

		const { findByText } = render(
			<TestWrapper>
				<ObjectFiles
					{...baseProps}
					relationships={{ asSource: [], asTarget: [rel] }}
				/>
			</TestWrapper>,
		)

		await findByText('inbound.png')
		expect(api.files.list).toHaveBeenCalledWith('ws-1', { ids: ['file-2'] })
	})

	it('ignores non-attached relationships regardless of their labels', async () => {
		const informs = buildRel({
			id: 'rel-informs',
			sourceType: 'object',
			sourceId: 'obj-1',
			targetType: 'object',
			targetId: 'obj-2',
			type: 'informs',
		})
		vi.mocked(api.files.list).mockResolvedValue([])

		render(
			<TestWrapper>
				<ObjectFiles
					{...baseProps}
					relationships={{ asSource: [informs], asTarget: [] }}
				/>
			</TestWrapper>,
		)

		// Empty ids → `useFiles` short-circuits and never calls the API.
		await waitFor(() => {
			expect(api.files.list).not.toHaveBeenCalled()
		})
	})
})

describe('ObjectFiles — scoped property menu', () => {
	it('renders attached files in a table with Name + Size by default', async () => {
		const file = buildFileItem({ name: 'spec.md', sizeBytes: 2048 })
		vi.mocked(api.files.list).mockResolvedValue([file])

		render(
			<TestWrapper>
				<ObjectFiles
					{...baseProps}
					relationships={{ asSource: [buildRel({ targetId: file.id })], asTarget: [] }}
				/>
			</TestWrapper>,
		)

		await screen.findByText('spec.md')
		expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument()
		expect(screen.getByRole('columnheader', { name: 'Size' })).toBeInTheDocument()
		expect(screen.queryByRole('columnheader', { name: 'Created' })).not.toBeInTheDocument()
		expect(screen.queryByRole('columnheader', { name: 'Modified' })).not.toBeInTheDocument()
	})

	it('toggling Created in the property menu shows the Created column for files in the same session', async () => {
		const user = userEvent.setup()
		const file = buildFileItem({ name: 'spec.md' })
		vi.mocked(api.files.list).mockResolvedValue([file])

		render(
			<TestWrapper>
				<ObjectFiles
					{...baseProps}
					relationships={{ asSource: [buildRel({ targetId: file.id })], asTarget: [] }}
				/>
			</TestWrapper>,
		)

		await screen.findByText('spec.md')
		expect(screen.queryByRole('columnheader', { name: 'Created' })).not.toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'File properties' }))
		await user.click(screen.getByRole('menuitemcheckbox', { name: 'Created' }))

		expect(screen.getByRole('columnheader', { name: 'Created' })).toBeInTheDocument()
	})

	it('toggling Modified off after on hides the Modified column again', async () => {
		const user = userEvent.setup()
		const file = buildFileItem({ name: 'spec.md' })
		vi.mocked(api.files.list).mockResolvedValue([file])

		render(
			<TestWrapper>
				<ObjectFiles
					{...baseProps}
					relationships={{ asSource: [buildRel({ targetId: file.id })], asTarget: [] }}
				/>
			</TestWrapper>,
		)

		await screen.findByText('spec.md')

		await user.click(screen.getByRole('button', { name: 'File properties' }))
		await user.click(screen.getByRole('menuitemcheckbox', { name: 'Modified' }))
		expect(screen.getByRole('columnheader', { name: 'Modified' })).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'File properties' }))
		await user.click(screen.getByRole('menuitemcheckbox', { name: 'Modified' }))
		expect(screen.queryByRole('columnheader', { name: 'Modified' })).not.toBeInTheDocument()
	})

	it('shows the empty-state uploader when no files are attached', () => {
		vi.mocked(api.files.list).mockResolvedValue([])

		render(
			<TestWrapper>
				<ObjectFiles {...baseProps} relationships={{ asSource: [], asTarget: [] }} />
			</TestWrapper>,
		)

		expect(screen.getByText('Drop a file here or click to upload')).toBeInTheDocument()
	})
})

describe('ObjectFiles — persisted column visibility', () => {
	it('rehydrates Created/Modified visibility from persisted settings under object_type "files"', async () => {
		const file = buildFileItem({ name: 'spec.md' })
		vi.mocked(api.files.list).mockResolvedValue([file])
		useUserDisplaySettingsMock.mockReturnValue(
			withPersisted({ created_at: true, modified_at: true }),
		)

		render(
			<TestWrapper>
				<ObjectFiles
					{...baseProps}
					relationships={{ asSource: [buildRel({ targetId: file.id })], asTarget: [] }}
				/>
			</TestWrapper>,
		)

		await waitFor(() => {
			expect(screen.getByRole('columnheader', { name: 'Created' })).toBeInTheDocument()
		})
		expect(screen.getByRole('columnheader', { name: 'Modified' })).toBeInTheDocument()
		expect(useUserDisplaySettingsMock).toHaveBeenCalledWith('ws-1', 'files')
	})

	it('falls back to default-OFF columns when no persisted settings exist', async () => {
		const file = buildFileItem({ name: 'spec.md' })
		vi.mocked(api.files.list).mockResolvedValue([file])
		useUserDisplaySettingsMock.mockReturnValue(noPersistedSettings())

		render(
			<TestWrapper>
				<ObjectFiles
					{...baseProps}
					relationships={{ asSource: [buildRel({ targetId: file.id })], asTarget: [] }}
				/>
			</TestWrapper>,
		)

		expect(screen.queryByRole('columnheader', { name: 'Created' })).not.toBeInTheDocument()
		expect(screen.queryByRole('columnheader', { name: 'Modified' })).not.toBeInTheDocument()
	})

	it('debounces a write-through to upsert under object_type "files" when a column is toggled', async () => {
		const user = userEvent.setup()
		const file = buildFileItem({ name: 'spec.md' })
		vi.mocked(api.files.list).mockResolvedValue([file])

		render(
			<TestWrapper>
				<ObjectFiles
					{...baseProps}
					relationships={{ asSource: [buildRel({ targetId: file.id })], asTarget: [] }}
				/>
			</TestWrapper>,
		)

		await screen.findByText('spec.md')
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
		const file = buildFileItem({ name: 'spec.md' })
		vi.mocked(api.files.list).mockResolvedValue([file])

		render(
			<TestWrapper>
				<ObjectFiles
					{...baseProps}
					relationships={{ asSource: [buildRel({ targetId: file.id })], asTarget: [] }}
				/>
			</TestWrapper>,
		)

		await screen.findByText('spec.md')
		await user.click(screen.getByRole('button', { name: 'File properties' }))
		await user.click(screen.getByRole('menuitemcheckbox', { name: 'Created' }))

		// Wait long enough that any debounced write would have fired (>500ms).
		await new Promise((resolve) => setTimeout(resolve, 700))
		expect(updateMutateMock).not.toHaveBeenCalled()
	})
})
