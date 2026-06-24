import { ImportDialog } from '@/components/imports/import-dialog'
import type { ImportResponse } from '@/lib/api'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildImportResponse } from '../../factories'
import { TestWrapper } from '../../setup'

const mockCreateImportMutateAsync = vi.fn()
const mockUpdateMappingMutateAsync = vi.fn()
const mockConfirmImportMutateAsync = vi.fn()
const mockCreateImportReset = vi.fn()
const mockConfirmImportReset = vi.fn()
const mockPreviewMutate = vi.fn()
let mockImportData: ImportResponse | undefined
let mockWorkspaceSettings: Record<string, unknown> = {}

vi.mock('@/hooks/use-imports', () => ({
	useCreateImport: () => ({
		mutateAsync: mockCreateImportMutateAsync,
		isPending: false,
		data: undefined,
		reset: mockCreateImportReset,
	}),
	useUpdateImportMapping: () => ({
		mutateAsync: mockUpdateMappingMutateAsync,
		isPending: false,
	}),
	useConfirmImport: () => ({
		mutateAsync: mockConfirmImportMutateAsync,
		isPending: false,
		reset: mockConfirmImportReset,
	}),
	useImport: () => ({
		data: mockImportData,
	}),
	useImportPreview: () => ({
		mutate: mockPreviewMutate,
		isPending: false,
	}),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({
		workspaceId: 'ws-1',
		workspace: { settings: mockWorkspaceSettings },
	}),
}))

const defaultMapping = {
	typeMappings: [
		{
			objectType: 'bet',
			columns: [
				{ sourceColumn: 'name', targetField: 'title', transform: 'none' as const, skip: false },
				{ sourceColumn: 'desc', targetField: 'content', transform: 'none' as const, skip: false },
			],
		},
	],
	relationships: [],
}

const defaultPreview = {
	columns: ['name', 'desc'],
	sampleRows: [{ name: 'Sample 1', desc: 'Description' }],
	totalRows: 10,
}

describe('ImportDialog', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockImportData = undefined
		mockWorkspaceSettings = {}
	})

	it('renders upload step when open=true', () => {
		render(<ImportDialog open={true} onOpenChange={vi.fn()} />, { wrapper: TestWrapper })
		expect(screen.getByText('Import Objects')).toBeInTheDocument()
		expect(screen.getByText('Drag and drop a file here')).toBeInTheDocument()
	})

	it('is not visible when open=false', () => {
		render(<ImportDialog open={false} onOpenChange={vi.fn()} />, { wrapper: TestWrapper })
		expect(screen.queryByText('Import Objects')).not.toBeInTheDocument()
	})

	it('shows file type hint (CSV/JSON)', () => {
		render(<ImportDialog open={true} onOpenChange={vi.fn()} />, { wrapper: TestWrapper })
		expect(screen.getByText('Supports CSV and JSON files')).toBeInTheDocument()
	})

	it('shows Browse files button', () => {
		render(<ImportDialog open={true} onOpenChange={vi.fn()} />, { wrapper: TestWrapper })
		expect(screen.getByText('Browse files')).toBeInTheDocument()
	})

	it('transitions to mapping step after file upload', async () => {
		const importRecord = buildImportResponse({
			totalRows: 10,
			mapping: defaultMapping,
			preview: defaultPreview,
		})
		mockCreateImportMutateAsync.mockResolvedValue(importRecord)
		mockImportData = importRecord

		render(<ImportDialog open={true} onOpenChange={vi.fn()} />, { wrapper: TestWrapper })

		// Simulate file upload via the hidden input
		const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
		const file = new File(['test'], 'data.csv', { type: 'text/csv' })
		await userEvent.upload(fileInput, file)

		await waitFor(() => {
			expect(mockCreateImportMutateAsync).toHaveBeenCalledWith(file)
		})

		await waitFor(() => {
			expect(screen.getByText('Source Column')).toBeInTheDocument()
		})
	})

	it('mapping step shows column mapping interface', async () => {
		const importRecord = buildImportResponse({
			totalRows: 10,
			mapping: defaultMapping,
			preview: defaultPreview,
		})
		mockCreateImportMutateAsync.mockResolvedValue(importRecord)
		mockImportData = importRecord

		render(<ImportDialog open={true} onOpenChange={vi.fn()} />, { wrapper: TestWrapper })

		const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
		const file = new File(['test'], 'data.csv', { type: 'text/csv' })
		await userEvent.upload(fileInput, file)

		await waitFor(() => {
			expect(screen.getByText('Source Column')).toBeInTheDocument()
			expect(screen.getByText('Maps To')).toBeInTheDocument()
			expect(screen.getByText('Sample')).toBeInTheDocument()
			expect(screen.getByText('name')).toBeInTheDocument()
			expect(screen.getByText('desc')).toBeInTheDocument()
		})
	})

	it('closes dialog and calls onImportStarted when import is confirmed', async () => {
		const importRecord = buildImportResponse({
			id: 'imp-123',
			totalRows: 10,
			mapping: defaultMapping,
			preview: defaultPreview,
		})
		mockCreateImportMutateAsync.mockResolvedValue(importRecord)
		mockConfirmImportMutateAsync.mockResolvedValue(importRecord)
		mockImportData = importRecord

		const onOpenChange = vi.fn()
		const onImportStarted = vi.fn()

		render(
			<ImportDialog open={true} onOpenChange={onOpenChange} onImportStarted={onImportStarted} />,
			{ wrapper: TestWrapper },
		)

		// Upload file
		const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
		const file = new File(['test'], 'data.csv', { type: 'text/csv' })
		await userEvent.upload(fileInput, file)

		await waitFor(() => {
			expect(screen.getByText(/Import 10 rows/)).toBeInTheDocument()
		})

		// Click import button
		await userEvent.click(screen.getByText(/Import 10 rows/))

		await waitFor(() => {
			expect(mockConfirmImportMutateAsync).toHaveBeenCalledWith('imp-123')
			expect(onImportStarted).toHaveBeenCalledWith('imp-123')
			expect(onOpenChange).toHaveBeenCalledWith(false)
		})
	})

	describe('Step 3 (preview) with dedup flag on', () => {
		const dedupSettings = {
			statuses: { bet: ['signal', 'shape'] },
			field_definitions: { bet: [{ name: 'email', type: 'string' }] },
			flags: { bulkImportDedup: true },
		}

		it('mapping step shows "Next: preview & match" instead of direct import', async () => {
			mockWorkspaceSettings = dedupSettings
			const importRecord = buildImportResponse({
				totalRows: 10,
				mapping: defaultMapping,
				preview: defaultPreview,
			})
			mockCreateImportMutateAsync.mockResolvedValue(importRecord)
			mockImportData = importRecord

			render(<ImportDialog open={true} onOpenChange={vi.fn()} />, { wrapper: TestWrapper })
			const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
			await userEvent.upload(fileInput, new File(['test'], 'data.csv', { type: 'text/csv' }))

			await waitFor(() => {
				expect(screen.getByRole('button', { name: /Next: preview & match/ })).toBeInTheDocument()
			})
			expect(screen.queryByText(/Import 10 rows/)).not.toBeInTheDocument()
		})

		it('renders dedup picker and three count cards on Step 3 (AC-U1, AC-U2)', async () => {
			mockWorkspaceSettings = dedupSettings
			const importRecord = buildImportResponse({
				totalRows: 10,
				mapping: defaultMapping,
				preview: defaultPreview,
			})
			mockCreateImportMutateAsync.mockResolvedValue(importRecord)
			mockImportData = importRecord

			render(<ImportDialog open={true} onOpenChange={vi.fn()} />, { wrapper: TestWrapper })
			const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
			await userEvent.upload(fileInput, new File(['test'], 'data.csv', { type: 'text/csv' }))

			await userEvent.click(await screen.findByRole('button', { name: /Next: preview & match/ }))

			expect(await screen.findByText('Match existing records by:')).toBeInTheDocument()
			expect(screen.getByRole('button', { name: /Dedup key title/ })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: /Dedup key email/ })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: /Jump to To update/ })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: /Jump to New to create/ })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: /Jump to Unchanged · skip/ })).toBeInTheDocument()
		})

		it('Run import is disabled until at least one dedup key is selected (AC-U4 frontend gate)', async () => {
			mockWorkspaceSettings = dedupSettings
			const importRecord = buildImportResponse({
				totalRows: 10,
				mapping: defaultMapping,
				preview: defaultPreview,
			})
			mockCreateImportMutateAsync.mockResolvedValue(importRecord)
			mockImportData = importRecord

			render(<ImportDialog open={true} onOpenChange={vi.fn()} />, { wrapper: TestWrapper })
			const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
			await userEvent.upload(fileInput, new File(['test'], 'data.csv', { type: 'text/csv' }))
			await userEvent.click(await screen.findByRole('button', { name: /Next: preview & match/ }))

			const runButton = await screen.findByRole('button', { name: /Run import/ })
			expect(runButton).toBeDisabled()

			await userEvent.click(screen.getByRole('button', { name: /Dedup key title/ }))
			expect(screen.getByRole('button', { name: /Run import/ })).toBeEnabled()
		})

		it('escape-hatch dialog renders verbatim AC-U4 copy with destructive confirm', async () => {
			mockWorkspaceSettings = dedupSettings
			const importRecord = buildImportResponse({
				totalRows: 847,
				mapping: defaultMapping,
				preview: { ...defaultPreview, totalRows: 847 },
			})
			mockCreateImportMutateAsync.mockResolvedValue(importRecord)
			mockImportData = importRecord

			render(<ImportDialog open={true} onOpenChange={vi.fn()} />, { wrapper: TestWrapper })
			const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
			await userEvent.upload(fileInput, new File(['test'], 'data.csv', { type: 'text/csv' }))
			await userEvent.click(await screen.findByRole('button', { name: /Next: preview & match/ }))

			await userEvent.click(
				await screen.findByRole('button', { name: /Skip matching — create all 847 as new/ }),
			)

			expect(
				await screen.findByText(
					"Importing without a dedup key creates duplicates for every row — pick at least one field, or confirm 'Create all as new'.",
				),
			).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Create all as new' })).toBeInTheDocument()
		})
	})

	it('resets to upload step when dialog closes and reopens', async () => {
		const importRecord = buildImportResponse({
			totalRows: 10,
			mapping: defaultMapping,
			preview: defaultPreview,
		})
		mockCreateImportMutateAsync.mockResolvedValue(importRecord)
		mockImportData = importRecord

		const onOpenChange = vi.fn()
		const { rerender } = render(<ImportDialog open={true} onOpenChange={onOpenChange} />, {
			wrapper: TestWrapper,
		})

		// Upload file to go to mapping step
		const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
		const file = new File(['test'], 'data.csv', { type: 'text/csv' })
		await userEvent.upload(fileInput, file)

		await waitFor(() => {
			expect(screen.getByText('Source Column')).toBeInTheDocument()
		})

		// Close dialog
		mockImportData = undefined
		rerender(<ImportDialog open={false} onOpenChange={onOpenChange} />)

		// Reopen dialog
		rerender(<ImportDialog open={true} onOpenChange={onOpenChange} />)

		expect(screen.getByText('Drag and drop a file here')).toBeInTheDocument()
	})
})
