import { ViewerStage } from '@/components/files/viewer-stage'
import { trackViewRefreshed } from '@/lib/analytics'
import { type FileDetail, type ObjectResponse, api } from '@/lib/api'
import {
	BRIDGE_QUERY_MESSAGE,
	BRIDGE_RESULT_MESSAGE,
	ISOLATION_LOAD_MESSAGE,
	VIEWER_DOC_SIZE_MESSAGE,
	VIEWER_WHEEL_MESSAGE,
} from '@/lib/mini-app'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { flagOn } = vi.hoisted(() => ({ flagOn: { value: true } }))
vi.mock('@/hooks/use-feature-flag', () => ({ useFeatureFlag: () => flagOn.value }))
vi.mock('@/lib/analytics', async () => ({
	...(await vi.importActual<typeof import('@/lib/analytics')>('@/lib/analytics')),
	trackViewRefreshed: vi.fn(),
	trackFileViewerZoomUsed: vi.fn(),
	trackFileViewerPageNavigated: vi.fn(),
}))
vi.mock('@/lib/api', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/api')>()),
	api: { objects: { list: vi.fn() }, data: { query: vi.fn() } },
}))

const LIST_VIEW = `<html><head></head><body>
<script id="maskin-sources" type="application/json">{"opps":{"list":"opportunities","params":{"status":["opportunity"]}},"loose":{"list":"people"}}</script>
<h1>Opportunities</h1></body></html>`

function htmlFile(content: string, overrides: Partial<FileDetail> = {}): FileDetail {
	return {
		id: 'file-1',
		workspaceId: 'ws-1',
		name: 'opportunities.html',
		description: null,
		mimeType: 'text/html',
		sizeBytes: 100,
		storageKey: 'k',
		createdBy: 'actor-1',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		content,
		encoding: 'utf8',
		url: 'http://localhost:5173/ws-1/files/file-1',
		annotations: [],
		...overrides,
	}
}

function bet(i: number): ObjectResponse {
	return {
		id: `bet-${i}`,
		workspaceId: 'ws-1',
		type: 'bet',
		title: `Opportunity ${i}`,
		content: 'long body',
		status: 'opportunity',
		metadata: { priority: 'P2', size: 'small', secret: 'x' },
		driver: null,
		activeSessionId: null,
		createdBy: 'actor-1',
		createdAt: null,
		updatedAt: '2026-11-01T00:00:00.000Z',
	}
}

const TITLE = 'Preview of opportunities.html'

/** Gives the stage a view window, as it would find inside the isolation frame. */
function viewWindow() {
	const frame = screen.getByTitle(TITLE) as HTMLIFrameElement
	const view = { postMessage: vi.fn() }
	Object.defineProperty(frame.contentWindow, 'frames', { value: [view], configurable: true })
	return view
}

async function ask(view: ReturnType<typeof viewWindow>, name: string, id = 1) {
	await act(async () => {
		window.dispatchEvent(
			new MessageEvent('message', {
				data: { type: BRIDGE_QUERY_MESSAGE, id, name },
				source: view as unknown as Window,
			}),
		)
	})
	return view.postMessage.mock.calls.map(([message]) => message).filter((m) => m.id === id)
}

describe('ViewerStage: living view', () => {
	beforeEach(() => {
		flagOn.value = true
		vi.mocked(api.objects.list).mockReset()
		vi.mocked(api.data.query).mockReset()
		vi.mocked(trackViewRefreshed).mockClear()
	})

	describe('flag off', () => {
		it('is exactly the viewer as before: no Refresh bar and no bridge', () => {
			flagOn.value = false
			render(<ViewerStage file={htmlFile(LIST_VIEW)} />)

			expect(screen.queryByTestId('view-refresh-bar')).toBeNull()
			const srcDoc = (screen.getByTitle(TITLE) as HTMLIFrameElement).getAttribute('srcdoc') ?? ''
			expect(srcDoc).not.toContain(BRIDGE_QUERY_MESSAGE)
			expect(srcDoc).toContain(VIEWER_DOC_SIZE_MESSAGE)
		})
	})

	describe('flag on', () => {
		it('hosts a file that names a list on the isolation frame, with the wheel forwarded', () => {
			render(<ViewerStage file={htmlFile(LIST_VIEW)} />)

			const outer = (screen.getByTitle(TITLE) as HTMLIFrameElement).getAttribute('srcdoc') ?? ''
			expect(outer).toContain("frame-src 'none'")
			expect(outer).toContain(ISOLATION_LOAD_MESSAGE)
			const inner =
				new DOMParser()
					.parseFromString(outer, 'text/html')
					.querySelector('iframe')
					?.getAttribute('srcdoc') ?? ''
			expect(inner).toContain(BRIDGE_QUERY_MESSAGE)
			expect(inner).toContain(VIEWER_WHEEL_MESSAGE)
			expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
		})

		it('leaves a file with no list sources alone', () => {
			render(<ViewerStage file={htmlFile('<html><body>hi</body></html>')} />)

			expect(screen.queryByTestId('view-refresh-bar')).toBeNull()
			const srcDoc = (screen.getByTitle(TITLE) as HTMLIFrameElement).getAttribute('srcdoc') ?? ''
			expect(srcDoc).not.toContain(BRIDGE_QUERY_MESSAGE)
		})

		it('fetches nothing on open and answers "not refreshed" before the first click', async () => {
			render(<ViewerStage file={htmlFile(LIST_VIEW)} />)
			const view = viewWindow()

			const answers = await ask(view, 'opps')

			expect(api.objects.list).not.toHaveBeenCalled()
			expect(answers).toEqual([
				{
					type: BRIDGE_RESULT_MESSAGE,
					id: 1,
					data: { rows: null, notRefreshed: true },
				},
			])
		})

		it('refuses a list the app does not offer, without failing the view', async () => {
			render(<ViewerStage file={htmlFile(LIST_VIEW)} />)
			const view = viewWindow()

			const answers = await ask(view, 'loose')

			expect(answers).toEqual([
				{
					type: BRIDGE_RESULT_MESSAGE,
					id: 1,
					error: "This view asks for data the app doesn't offer",
				},
			])
			expect(api.objects.list).not.toHaveBeenCalled()
		})

		it('ignores a list ask that does not come from the view frame', async () => {
			render(<ViewerStage file={htmlFile(LIST_VIEW)} />)
			const view = viewWindow()

			await act(async () => {
				window.dispatchEvent(
					new MessageEvent('message', {
						data: { type: BRIDGE_QUERY_MESSAGE, id: 1, name: 'opps' },
						source: { postMessage: vi.fn() } as unknown as Window,
					}),
				)
			})

			expect(view.postMessage).not.toHaveBeenCalled()
		})

		it('after a click, fetches as the viewer, replaces the frame and answers with contract fields only', async () => {
			vi.mocked(api.objects.list).mockResolvedValueOnce([bet(1), bet(2)])
			render(<ViewerStage file={htmlFile(LIST_VIEW)} />)
			const before = screen.getByTitle(TITLE)

			fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
			// The bar already reads "Refreshed just now" from the file's own time, so wait for the
			// frame itself to be replaced: that happens only once the fetch has finished.
			await waitFor(() => expect(screen.getByTitle(TITLE)).not.toBe(before))

			expect(api.objects.list).toHaveBeenCalledTimes(1)
			expect(vi.mocked(api.objects.list).mock.calls[0]?.[0]).toBe('ws-1')
			// The new frame asks again and is told the rows.
			const view = viewWindow()
			const answers = await ask(view, 'opps', 2)
			expect(answers).toHaveLength(1)
			expect(answers[0].data.rows).toHaveLength(2)
			expect(answers[0].data.rows[0]).toEqual({
				id: 'bet-1',
				title: 'Opportunity 1',
				status: 'opportunity',
				priority: 'P2',
				size: 'small',
				size_is_guess: null,
				evidence_strength: null,
				moves_the_bar: null,
				problem_space: null,
				updatedAt: '2026-11-01T00:00:00.000Z',
			})
			expect(JSON.stringify(answers)).not.toContain('long body')
			expect(JSON.stringify(answers)).not.toContain('secret')
			expect(trackViewRefreshed).toHaveBeenCalledWith({
				entity_id: 'file-1',
				entity_type: 'file',
				list_names: 'opportunities',
				row_count: 2,
				ok: true,
			})
		})

		it('says it could not refresh, keeps the time of the data on screen and offers Try again', async () => {
			vi.mocked(api.objects.list).mockRejectedValueOnce(new Error('boom'))
			vi.spyOn(console, 'error').mockImplementation(() => {})
			render(<ViewerStage file={htmlFile(LIST_VIEW)} />)

			fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

			await waitFor(() =>
				expect(screen.getByText(/Couldn't refresh\. Showing data from/)).toBeInTheDocument(),
			)
			expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
			expect(trackViewRefreshed).toHaveBeenCalledWith(
				expect.objectContaining({ ok: false, row_count: 0 }),
			)
		})

		it('flags data older than a day in amber', () => {
			const old = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString()
			render(<ViewerStage file={htmlFile(LIST_VIEW, { updatedAt: old })} />)

			expect(screen.getByText(/Refreshed 1 d ago/)).toHaveAttribute('data-stale', 'true')
		})

		it('does not mark fresh data as stale', () => {
			render(<ViewerStage file={htmlFile(LIST_VIEW)} />)

			expect(screen.getByText(/Refreshed just now/)).not.toHaveAttribute('data-stale')
		})

		it('stops answering and shows the blocked tile when the view loads a second time', async () => {
			render(<ViewerStage file={htmlFile(LIST_VIEW)} />)
			const frame = screen.getByTitle(TITLE) as HTMLIFrameElement
			const view = viewWindow()
			const loaded = () =>
				window.dispatchEvent(
					new MessageEvent('message', {
						data: { type: ISOLATION_LOAD_MESSAGE },
						source: frame.contentWindow,
					}),
				)

			await act(async () => loaded())
			expect(await ask(view, 'opps', 1)).toHaveLength(1)

			await act(async () => loaded())
			expect(await ask(view, 'opps', 2)).toHaveLength(0)
			expect(screen.getByRole('application')).toHaveAttribute('data-viewer-state', 'iframe-blocked')
		})

		it('takes the view size from the inner frame, so the stage can fit it', async () => {
			render(<ViewerStage file={htmlFile(LIST_VIEW)} />)
			const view = viewWindow()

			await act(async () => {
				window.dispatchEvent(
					new MessageEvent('message', {
						data: { type: VIEWER_DOC_SIZE_MESSAGE, w: 800, cw: 800, h: 600 },
						source: view as unknown as Window,
					}),
				)
			})

			expect(screen.getByRole('application')).toHaveAttribute('data-viewer-state', 'ready')
		})
	})
})
