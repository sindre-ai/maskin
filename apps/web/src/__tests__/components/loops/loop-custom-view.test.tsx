import { LoopCustomView } from '@/components/loops/loop-custom-view'
import type { FileDetail } from '@/lib/api'
import { MINI_APP_CSP } from '@/lib/mini-app'
import { act, fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const { useFileMock } = vi.hoisted(() => ({ useFileMock: vi.fn() }))
vi.mock('@/hooks/use-files', () => ({ useFile: useFileMock }))
vi.mock('@/lib/api', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/api')>()),
	api: { data: { query: vi.fn() } },
}))

const VALID_VIEW = `<html><head></head><body>
<script id="maskin-sources" type="application/json">{"by_status":{"type":"task","group_by":"status"}}</script>
<h1>Pipeline</h1></body></html>`

function file(overrides: Partial<FileDetail> = {}): FileDetail {
	return {
		id: 'file-1',
		workspaceId: 'ws-1',
		name: 'view.html',
		description: null,
		mimeType: 'text/html',
		sizeBytes: 10,
		storageKey: 'k',
		createdBy: 'actor-1',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		content: VALID_VIEW,
		encoding: 'utf8',
		url: 'http://localhost/ws-1/files/file-1',
		annotations: [],
		...overrides,
	}
}

function renderView(onFailure = vi.fn()) {
	const utils = render(
		<LoopCustomView workspaceId="ws-1" fileId="file-1" onFailure={onFailure} />,
		{
			wrapper: TestWrapper,
		},
	)
	return { ...utils, onFailure }
}

describe('LoopCustomView', () => {
	beforeEach(() => {
		useFileMock.mockReset()
		useFileMock.mockReturnValue({ data: file(), isLoading: false, isError: false })
	})

	it('renders the view in a script-only sandbox under the unchanged platform CSP', () => {
		const { container, onFailure } = renderView()

		const iframe = container.querySelector('iframe')
		expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts')
		const srcdoc = iframe?.getAttribute('srcdoc') ?? ''
		expect(srcdoc).toContain(`content="${MINI_APP_CSP}"`)
		expect(srcdoc).toContain('window.maskin={query:')
		expect(srcdoc).toContain('<h1>Pipeline</h1>')
		expect(onFailure).not.toHaveBeenCalled()
	})

	it('shows a skeleton while the file loads', () => {
		useFileMock.mockReturnValue({ data: undefined, isLoading: true, isError: false })
		const { container, onFailure } = renderView()
		expect(container.querySelector('iframe')).toBeNull()
		expect(onFailure).not.toHaveBeenCalled()
	})

	it('falls back when the file cannot be loaded', () => {
		useFileMock.mockReturnValue({ data: undefined, isLoading: false, isError: true })
		const { container, onFailure } = renderView()
		expect(container.querySelector('iframe')).toBeNull()
		expect(onFailure).toHaveBeenCalledWith('The view file could not be loaded.')
	})

	it('falls back when the file is not html', () => {
		useFileMock.mockReturnValue({
			data: file({ mimeType: 'text/markdown', content: '# hi' }),
			isLoading: false,
			isError: false,
		})
		const { container, onFailure } = renderView()
		expect(container.querySelector('iframe')).toBeNull()
		expect(onFailure).toHaveBeenCalledWith('The view file is not an HTML file.')
	})

	it('falls back when the declared sources do not parse', () => {
		useFileMock.mockReturnValue({
			data: file({
				content:
					'<html><body><script id="maskin-sources" type="application/json">{oops</script></body></html>',
			}),
			isLoading: false,
			isError: false,
		})
		const { container, onFailure } = renderView()
		expect(container.querySelector('iframe')).toBeNull()
		expect(onFailure).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'))
	})

	describe('a frame that navigates away', () => {
		// A srcdoc frame loads once. jsdom may fire a load of its own when the
		// iframe attaches, so each case first settles to a known "one load seen".
		async function mounted() {
			const utils = renderView()
			await act(async () => {})
			return utils
		}

		it('replaces the frame with a fresh one after a second load', async () => {
			const { container } = await mounted()
			const first = container.querySelector('iframe') as HTMLIFrameElement
			fireEvent.load(first)
			fireEvent.load(first)

			const replaced = container.querySelector('iframe')
			expect(replaced).not.toBeNull()
			expect(replaced).not.toBe(first)
		})

		it('gives up and falls back when the view keeps navigating', async () => {
			const { container, onFailure } = await mounted()
			for (let i = 0; i < 6 && !onFailure.mock.calls.length; i++) {
				const frame = container.querySelector('iframe') as HTMLIFrameElement
				fireEvent.load(frame)
				fireEvent.load(frame)
			}
			expect(onFailure).toHaveBeenCalledWith('The view tried to navigate away and was stopped.')
		})
	})
})
