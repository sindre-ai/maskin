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

	it('offers a match key when the type maps a title, and hides the on-match choice until one is set', async () => {
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
			expect(screen.getByRole('combobox', { name: 'Match existing on' })).toBeInTheDocument()
		})
		expect(
			screen.queryByRole('combobox', { name: 'If a row matches an existing object' }),
		).not.toBeInTheDocument()
	})

	it('refreshes the match-existing-on options to the new type when the object type changes', async () => {
		mockWorkspaceSettings = {
			statuses: {
				contact: ['active'],
				company: ['active'],
			},
			field_definitions: {
				contact: [
					{ name: 'email', type: 'string' },
					{ name: 'phone', type: 'string' },
				],
				company: [
					{ name: 'domain', type: 'string' },
					{ name: 'employees', type: 'number' },
				],
			},
			display_names: { contact: 'Contact', company: 'Company' },
		}
		const mappingOnContact = {
			typeMappings: [
				{
					objectType: 'contact',
					columns: [
						{
							sourceColumn: 'email',
							targetField: 'metadata.email',
							transform: 'none' as const,
							skip: false,
						},
						{
							sourceColumn: 'phone',
							targetField: 'metadata.phone',
							transform: 'none' as const,
							skip: false,
						},
					],
				},
			],
			relationships: [],
		}
		const importRecord = buildImportResponse({
			id: 'imp-type-change',
			totalRows: 5,
			mapping: mappingOnContact,
			preview: {
				columns: ['email', 'phone'],
				sampleRows: [{ email: 'a@b.co', phone: '+1' }],
				totalRows: 5,
			},
		})
		mockCreateImportMutateAsync.mockResolvedValue(importRecord)
		mockImportData = importRecord

		render(<ImportDialog open={true} onOpenChange={vi.fn()} />, { wrapper: TestWrapper })

		const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
		await userEvent.upload(fileInput, new File(['test'], 'data.csv', { type: 'text/csv' }))

		// While type is "contact", the match dropdown offers the contact metadata fields.
		const matchDropdownContact = await screen.findByRole('combobox', {
			name: 'Match existing on',
		})
		await userEvent.click(matchDropdownContact)
		expect(await screen.findByRole('option', { name: 'email' })).toBeInTheDocument()
		expect(screen.getByRole('option', { name: 'phone' })).toBeInTheDocument()
		// Close the popover before switching type
		await userEvent.keyboard('{Escape}')

		// Switch the object type to "company".
		const typeCombos = screen.getAllByRole('combobox')
		const typeSelect = typeCombos.find((el) => el.textContent === 'Contact')
		if (!typeSelect) throw new Error('type select not found')
		await userEvent.click(typeSelect)
		await userEvent.click(await screen.findByRole('option', { name: 'Company' }))

		// After the change, the contact fields must not be offered as dedupe keys — the
		// column mappings pointed at the previous type's metadata and are now stale.
		await waitFor(() => {
			expect(screen.queryByRole('combobox', { name: 'Match existing on' })).not.toBeInTheDocument()
		})
	})

	it('sends the match key and on-match choice with the mapping before confirming', async () => {
		const mappingWithMatch = {
			...defaultMapping,
			typeMappings: [{ ...defaultMapping.typeMappings[0], matchOn: 'title' }],
		}
		const importRecord = buildImportResponse({
			id: 'imp-match',
			totalRows: 10,
			mapping: mappingWithMatch,
			preview: defaultPreview,
		})
		mockCreateImportMutateAsync.mockResolvedValue(importRecord)
		mockConfirmImportMutateAsync.mockResolvedValue(importRecord)
		mockImportData = importRecord

		render(<ImportDialog open={true} onOpenChange={vi.fn()} />, { wrapper: TestWrapper })

		const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
		await userEvent.upload(fileInput, new File(['test'], 'data.csv', { type: 'text/csv' }))

		await waitFor(() => {
			expect(
				screen.getByRole('combobox', { name: 'If a row matches an existing object' }),
			).toBeInTheDocument()
		})
		await userEvent.click(screen.getByText(/Import 10 rows/))

		await waitFor(() => {
			expect(mockUpdateMappingMutateAsync).toHaveBeenCalledWith({
				id: 'imp-match',
				mapping: expect.objectContaining({
					onMatch: 'skip',
					typeMappings: [expect.objectContaining({ matchOn: 'title' })],
				}),
			})
			expect(mockConfirmImportMutateAsync).toHaveBeenCalledWith('imp-match')
		})
	})
})
