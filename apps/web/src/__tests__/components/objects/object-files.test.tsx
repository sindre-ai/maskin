import { ObjectFiles } from '@/components/objects/object-files'
import type { ObjectGraphFileSummary } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/hooks/use-files', () => ({
	useFile: () => ({ data: null }),
	useCreateFile: () => ({ mutateAsync: vi.fn() }),
}))

vi.mock('@/hooks/use-relationships', () => ({
	useCreateRelationship: () => ({ mutateAsync: vi.fn() }),
}))

function buildFile(overrides: Partial<ObjectGraphFileSummary> = {}): ObjectGraphFileSummary {
	return {
		id: 'file-1',
		name: 'notes.md',
		mimeType: 'text/markdown',
		sizeBytes: 128,
		url: 'http://localhost/files/file-1',
		...overrides,
	}
}

describe('ObjectFiles', () => {
	it('renders attached files from the graph payload without inspecting relationship labels', () => {
		// The backend already resolves file endpoints by files.id membership
		// (see the graph handler). The component receives the resolved file
		// summaries directly — it must render them regardless of the stored
		// sourceType/targetType label on the underlying relationship.
		render(
			<TestWrapper>
				<ObjectFiles
					workspaceId="ws-1"
					objectId="obj-1"
					objectType="bet"
					files={[buildFile({ name: 'legacy-labelled-file.md' })]}
				/>
			</TestWrapper>,
		)

		expect(screen.getByText('legacy-labelled-file.md')).toBeInTheDocument()
		expect(screen.getByText('Files (1)')).toBeInTheDocument()
	})

	it('shows the empty-state affordance when no files are attached', () => {
		render(
			<TestWrapper>
				<ObjectFiles workspaceId="ws-1" objectId="obj-1" objectType="bet" files={[]} />
			</TestWrapper>,
		)

		expect(screen.getByText(/drop a file here/i)).toBeInTheDocument()
		expect(screen.getByText('Files (0)')).toBeInTheDocument()
	})

	it('handles multiple files', () => {
		render(
			<TestWrapper>
				<ObjectFiles
					workspaceId="ws-1"
					objectId="obj-1"
					objectType="bet"
					files={[
						buildFile({ id: 'f1', name: 'first.md' }),
						buildFile({ id: 'f2', name: 'second.md' }),
					]}
				/>
			</TestWrapper>,
		)

		expect(screen.getByText('first.md')).toBeInTheDocument()
		expect(screen.getByText('second.md')).toBeInTheDocument()
		expect(screen.getByText('Files (2)')).toBeInTheDocument()
	})
})
