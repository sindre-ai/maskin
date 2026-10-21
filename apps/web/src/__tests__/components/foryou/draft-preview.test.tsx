import { DraftPreview } from '@/components/foryou/draft-preview'
import type { LatestMentionDecisionDraft } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/shared/file-preview', () => ({
	FilePreview: ({
		fileId,
		meta,
		defaultExpanded,
	}: {
		fileId: string
		meta: { name: string; mimeType: string; sizeBytes: number }
		defaultExpanded?: boolean
	}) => (
		<div data-testid="file-preview" data-open={String(Boolean(defaultExpanded))}>
			{fileId}|{meta.name}|{meta.mimeType}|{meta.sizeBytes}
		</div>
	),
}))

const preview = {
	kind: 'linkedin_post',
	label: 'LinkedIn post',
	provider: 'linkedin-unipile',
	recipients: [],
	subject: null,
	details: [{ label: 'Posting as', value: 'sebk_personal' }],
	body: 'The post.',
	maxLength: 3000,
	missing: [],
	warnings: [],
	content_hash: 'h',
}

describe('DraftPreview', () => {
	it('shows the whole text with its label', () => {
		const draft: LatestMentionDecisionDraft = { label: 'Email to Hans', body: 'Hej Hans.' }
		render(<DraftPreview workspaceId="ws-1" draft={draft} />)
		expect(screen.getByRole('region', { name: 'Email to Hans' })).toBeInTheDocument()
		expect(screen.getByText('Hej Hans.')).toBeInTheDocument()
	})

	it('shows where a post is published, from its preview', () => {
		render(
			<DraftPreview
				workspaceId="ws-1"
				draft={{ label: 'LinkedIn post', body: 'The post.', preview }}
			/>,
		)
		expect(screen.getByText('Posting as')).toBeInTheDocument()
		expect(screen.getByText('sebk_personal')).toBeInTheDocument()
	})

	it('shows nothing for a draft with no text and no file', () => {
		const { container } = render(<DraftPreview workspaceId="ws-1" draft={{ label: 'Draft' }} />)
		expect(container).toBeEmptyDOMElement()
	})

	it('shows a file the card is about, open, instead of text', () => {
		render(
			<DraftPreview
				workspaceId="ws-1"
				draft={{
					file_id: 'file-1',
					label: 'Launch page',
					file: { id: 'file-1', name: 'launch.html', mime_type: 'text/html', size_bytes: 900 },
				}}
			/>,
		)
		const card = screen.getByTestId('file-preview')
		expect(card).toHaveTextContent('file-1|launch.html|text/html|900')
		expect(card).toHaveAttribute('data-open', 'true')
	})
})
