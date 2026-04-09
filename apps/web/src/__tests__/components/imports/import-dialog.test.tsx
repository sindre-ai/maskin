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
let mockImportData: ImportResponse | undefined

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
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({
		workspaceId: 'ws-1',
		workspace: { settings: {} },
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
