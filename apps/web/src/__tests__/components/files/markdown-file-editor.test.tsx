import {
	FILE_EDITOR_HELPER_LINE,
	MarkdownFileEditor,
	READ_ONLY_FILE_BANNER,
} from '@/components/files/markdown-file-editor'
import type { FileSaveClient } from '@/hooks/use-markdown-file-save'
import { capture } from '@/lib/posthog'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/posthog', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/posthog')>()),
	capture: vi.fn(),
}))

function buildClient(): FileSaveClient {
	return {
		save: vi.fn(async () => ({ hash: 'h1' })),
		fetchLatest: vi.fn(async () => ({ text: '', hash: 'h1' })),
	}
}

function mount(text: string, { canEdit = true, client = buildClient() } = {}) {
	const utils = render(
		<MarkdownFileEditor fileId="file-1" text={text} hash="h0" client={client} canEdit={canEdit} />,
		{ wrapper: TestWrapper },
	)
	return { ...utils, client }
}

beforeEach(() => {
	vi.mocked(capture).mockClear()
})

describe('MarkdownFileEditor', () => {
	it('opens the document as an editor with the helper line and the Rendered and Source toggle', async () => {
		const { container } = mount('# Title\n\nbody text')
		await waitFor(() => expect(container.querySelector('.ProseMirror')).not.toBeNull())

		expect(screen.getByText(FILE_EDITOR_HELPER_LINE)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Rendered' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Source' })).toBeInTheDocument()
		expect(screen.queryByText(READ_ONLY_FILE_BANNER)).toBeNull()
	})

	it('shows the plain markdown on the Source tab', async () => {
		const { container } = mount('# Title\n\nbody text')
		await waitFor(() => expect(container.querySelector('.ProseMirror')).not.toBeNull())

		fireEvent.click(screen.getByRole('button', { name: 'Source' }))

		expect(container.querySelector('pre')?.textContent).toBe('# Title\n\nbody text')
	})

	it('sends no save request when the file is opened and not edited', async () => {
		const { container, client } = mount('# Title\n\nbody text')
		await waitFor(() => expect(container.querySelector('.ProseMirror')).not.toBeNull())
		await new Promise((resolve) => setTimeout(resolve, 900))

		expect(client.save).not.toHaveBeenCalled()
	})

	it('opens a file with front matter read-only, with the banner line and one read_only_fallback event', async () => {
		const { container, client } = mount('---\ntitle: Spec\n---\n\n# Hi\n')

		expect(await screen.findByText(READ_ONLY_FILE_BANNER)).toBeInTheDocument()
		expect(container.querySelector('[contenteditable="true"]')).toBeNull()
		expect(screen.queryByText(FILE_EDITOR_HELPER_LINE)).toBeNull()
		expect(client.save).not.toHaveBeenCalled()

		const events = vi
			.mocked(capture)
			.mock.calls.filter(([name]) => name === 'editor_markdown_parse_error')
		expect(events).toHaveLength(1)
		expect(events[0]?.[1]).toMatchObject({
			reason: 'read_only_fallback',
			cause: 'front_matter',
			surface: 'file',
		})
	})

	it('gives viewers the rendered document and no editor', () => {
		const { container } = mount('# Title\n\nbody text', { canEdit: false })

		expect(container.querySelector('.ProseMirror')).toBeNull()
		expect(container.querySelector('[contenteditable]')).toBeNull()
		expect(screen.getByText('body text')).toBeInTheDocument()
		expect(screen.queryByText(FILE_EDITOR_HELPER_LINE)).toBeNull()
	})
})
