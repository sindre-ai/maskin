import { LoopCustomView } from '@/components/loops/loop-custom-view'
import type { FileDetail } from '@/lib/api'
import { api } from '@/lib/api'
import {
	BRIDGE_QUERY_MESSAGE,
	ISOLATION_LOAD_MESSAGE,
	MINI_APP_CSP,
	VIEWER_DOC_SIZE_MESSAGE,
} from '@/lib/mini-app'
import { dataQuerySpecSchema } from '@maskin/shared'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const { useFileMock, sseListeners } = vi.hoisted(() => ({
	useFileMock: vi.fn(),
	sseListeners: [] as Array<(event: { entity_type: string } | null) => void>,
}))
vi.mock('@/hooks/use-files', () => ({ useFile: useFileMock }))
vi.mock('@/lib/sse-invalidation', () => ({
	subscribeToSSE: (listener: (event: { entity_type: string } | null) => void) => {
		sseListeners.push(listener)
		return () => {}
	},
}))
vi.mock('@/lib/api', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/api')>()),
	api: { data: { query: vi.fn(), nextChange: vi.fn() } },
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

/**
 * The newest frame. A replacement loads hidden after the one on screen, so it is the last one
 * in the box; most of the time there is only one.
 */
function latestFrame(container: HTMLElement) {
	const frames = container.querySelectorAll<HTMLIFrameElement>('iframe')
	return frames.length > 0 ? frames[frames.length - 1] : null
}

/** The view's own document: the srcdoc of the frame inside the isolation frame the host renders. */
function viewDoc(container: HTMLElement) {
	const outer = latestFrame(container)?.getAttribute('srcdoc') ?? ''
	return (
		new DOMParser()
			.parseFromString(outer, 'text/html')
			.querySelector('iframe')
			?.getAttribute('srcdoc') ?? ''
	)
}

/**
 * Stands in for the view frame: the host reaches it as the first child frame of the iframe it
 * renders. jsdom does not run nested srcdoc frames, so the window is supplied here.
 */
function viewWindowOf(container: HTMLElement) {
	const frame = latestFrame(container) as HTMLIFrameElement
	const view = { postMessage: vi.fn() }
	Object.defineProperty(frame.contentWindow, 'frames', { value: [view], configurable: true })
	return { frame, view }
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
		vi.mocked(api.data.query).mockReset()
		vi.mocked(api.data.nextChange).mockReset()
		vi.mocked(api.data.nextChange).mockResolvedValue({ in_ms: null })
		sseListeners.length = 0
		localStorage.clear()
	})

	it('renders the view in a script-only sandbox under the unchanged platform CSP', () => {
		const { container, onFailure } = renderView()

		const iframe = latestFrame(container)
		expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts')
		expect(iframe?.getAttribute('srcdoc')).toContain('frame-src')
		const srcdoc = viewDoc(container)
		expect(srcdoc).toContain(`content="${MINI_APP_CSP}"`)
		expect(srcdoc).toContain('window.maskin={query:')
		expect(srcdoc).toContain('<h1>Pipeline</h1>')
		expect(onFailure).not.toHaveBeenCalled()
	})

	it('shows a skeleton while the file loads', () => {
		useFileMock.mockReturnValue({ data: undefined, isLoading: true, isError: false })
		const { container, onFailure } = renderView()
		expect(latestFrame(container)).toBeNull()
		expect(onFailure).not.toHaveBeenCalled()
	})

	it('falls back when the file cannot be loaded', () => {
		useFileMock.mockReturnValue({ data: undefined, isLoading: false, isError: true })
		const { container, onFailure } = renderView()
		expect(latestFrame(container)).toBeNull()
		expect(onFailure).toHaveBeenCalledWith('The view file could not be loaded.')
	})

	it('falls back when the file is not html', () => {
		useFileMock.mockReturnValue({
			data: file({ mimeType: 'text/markdown', content: '# hi' }),
			isLoading: false,
			isError: false,
		})
		const { container, onFailure } = renderView()
		expect(latestFrame(container)).toBeNull()
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
		expect(latestFrame(container)).toBeNull()
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

		/** The isolation frame reporting that the view frame loaded. */
		async function viewLoaded(frame: HTMLIFrameElement) {
			await act(async () => {
				window.dispatchEvent(
					new MessageEvent('message', {
						data: { type: ISOLATION_LOAD_MESSAGE },
						source: frame.contentWindow,
					}),
				)
			})
		}

		it('replaces the frame with a fresh one after a second load', async () => {
			const { container } = await mounted()
			const first = latestFrame(container) as HTMLIFrameElement
			await viewLoaded(first)
			await viewLoaded(first)

			const replaced = latestFrame(container)
			expect(replaced).not.toBeNull()
			expect(replaced).not.toBe(first)
		})

		it('gives up and falls back when the view keeps navigating', async () => {
			const { container, onFailure } = await mounted()
			for (let i = 0; i < 6 && !onFailure.mock.calls.length; i++) {
				const frame = latestFrame(container) as HTMLIFrameElement
				await viewLoaded(frame)
				await viewLoaded(frame)
			}
			expect(onFailure).toHaveBeenCalledWith('The view tried to navigate away and was stopped.')
		})

		it('ignores a load report that does not come from the isolation frame', async () => {
			const { container } = await mounted()
			const first = latestFrame(container) as HTMLIFrameElement
			const { view } = viewWindowOf(container)
			for (let i = 0; i < 3; i++) {
				await act(async () => {
					window.dispatchEvent(
						new MessageEvent('message', {
							data: { type: ISOLATION_LOAD_MESSAGE },
							source: view as unknown as Window,
						}),
					)
				})
			}
			expect(latestFrame(container)).toBe(first)
		})
	})

	describe('data the viewer is told about', () => {
		const answer = (overrides = {}) => ({
			groups: [],
			total: { count: 3, value: 3 },
			next_cursor: null,
			rows_truncated: false,
			groups_truncated: false,
			...overrides,
		})

		/** The frame asks for its declared source, as window.maskin.query would. */
		async function ask(container: HTMLElement) {
			const { view } = viewWindowOf(container)
			await act(async () => {
				window.dispatchEvent(
					new MessageEvent('message', {
						data: { type: BRIDGE_QUERY_MESSAGE, id: 1, name: 'by_status' },
						source: view as unknown as Window,
					}),
				)
			})
		}

		afterEach(() => {
			vi.useRealTimers()
			vi.restoreAllMocks()
		})

		// The server no longer caps anything, so this is only an older server still mid-deploy.
		it('says so, outside the frame, when an answer comes back flagged partial', async () => {
			vi.mocked(api.data.query).mockResolvedValue(answer({ rows_truncated: true }))
			const { container } = renderView()
			await act(async () => {})
			expect(screen.queryByText(/partial/)).toBeNull()

			await ask(container)

			expect(screen.getByText(/Some numbers in this view are partial/)).toBeTruthy()
		})

		describe('saved answers', () => {
			// The host keys the cache by the spec as parsed, so the schema's defaults are part of the key.
			const SPEC_KEY = JSON.stringify(
				dataQuerySpecSchema.parse({ type: 'task', group_by: 'status' }),
			)
			const savedAt = new Date(2026, 10, 4, 9, 5).getTime()

			function save(result: object) {
				localStorage.setItem(
					`maskin-loop-view:ws-1:${SPEC_KEY}`,
					JSON.stringify({ at: savedAt, result }),
				)
			}

			/** Asks as the frame would and returns the answers the host posted back to it. */
			async function askAndRead(container: HTMLElement) {
				const { view } = viewWindowOf(container)
				await act(async () => {
					window.dispatchEvent(
						new MessageEvent('message', {
							data: { type: BRIDGE_QUERY_MESSAGE, id: 1, name: 'by_status' },
							source: view as unknown as Window,
						}),
					)
				})
				return view.postMessage.mock.calls.map(([message]) => message.data)
			}

			it('gives the view the saved answer at once, shows when it was saved, and spins until the server answers', async () => {
				save(answer())
				let resolve: (value: ReturnType<typeof answer>) => void = () => {}
				vi.mocked(api.data.query).mockReturnValue(
					new Promise((r) => {
						resolve = r
					}),
				)
				const { container } = renderView()
				await act(async () => {})
				const posted = await askAndRead(container)

				expect(posted).toEqual([answer()])
				expect(screen.getByText('Updated 4th Nov 09:05')).toBeTruthy()
				expect(container.querySelector('svg.animate-spin')).not.toBeNull()

				await act(async () => resolve(answer()))
				expect(container.querySelector('svg.animate-spin')).toBeNull()
				expect(screen.queryByText('Updated 4th Nov 09:05')).toBeNull()
				expect(
					screen.getByText(/^Updated \d{1,2}(st|nd|rd|th) [A-Z][a-z]{2} \d\d:\d\d$/),
				).toBeTruthy()
			})

			it('keeps the frame when the server agrees with the saved answer', async () => {
				save(answer())
				vi.mocked(api.data.query).mockResolvedValue(answer())
				const { container } = renderView()
				await act(async () => {})
				const first = latestFrame(container)
				await ask(container)
				expect(latestFrame(container)).toBe(first)
			})

			it('replaces the frame, and hands it the server answer, when the server disagrees', async () => {
				save(answer())
				const latest = answer({ total: { count: 9, value: 9 } })
				vi.mocked(api.data.query).mockResolvedValue(latest)
				const { container } = renderView()
				await act(async () => {})
				const first = latestFrame(container)
				expect(await askAndRead(container)).toEqual([answer()])

				expect(latestFrame(container)).not.toBe(first)
				expect(await askAndRead(container)).toEqual([latest])
				expect(vi.mocked(api.data.query)).toHaveBeenCalledTimes(1)
			})

			it('keeps the saved answer, says the refresh failed and offers a Refresh button', async () => {
				vi.spyOn(console, 'error').mockImplementation(() => {})
				save(answer())
				vi.mocked(api.data.query).mockRejectedValue(new Error('boom'))
				const { container } = renderView()
				await act(async () => {})
				const first = latestFrame(container)
				await ask(container)

				expect(latestFrame(container)).toBe(first)
				expect(screen.getByText('Refresh failed')).toBeTruthy()
				expect(screen.getByRole('button', { name: /Refresh/ })).toBeTruthy()
				expect(screen.getByText('Updated 4th Nov 09:05')).toBeTruthy()
			})

			it('clears the failure and the old time when Refresh succeeds with the same numbers', async () => {
				vi.spyOn(console, 'error').mockImplementation(() => {})
				save(answer())
				vi.mocked(api.data.query).mockRejectedValueOnce(new Error('boom'))
				const { container } = renderView()
				await act(async () => {})
				const first = latestFrame(container)
				await ask(container)

				vi.mocked(api.data.query).mockResolvedValue(answer())
				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
				})

				expect(screen.queryByText('Refresh failed')).toBeNull()
				expect(screen.queryByRole('button', { name: /Refresh/ })).toBeNull()
				expect(screen.queryByText('Updated 4th Nov 09:05')).toBeNull()
				expect(latestFrame(container)).toBe(first)
			})

			it('redraws with the new numbers when Refresh finds a different answer', async () => {
				vi.spyOn(console, 'error').mockImplementation(() => {})
				save(answer())
				const latest = answer({ total: { count: 9, value: 9 } })
				vi.mocked(api.data.query).mockRejectedValueOnce(new Error('boom'))
				const { container } = renderView()
				await act(async () => {})
				const first = latestFrame(container)
				await ask(container)

				vi.mocked(api.data.query).mockResolvedValue(latest)
				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
				})

				expect(latestFrame(container)).not.toBe(first)
				expect(await askAndRead(container)).toEqual([latest])
			})

			it('still says refresh failed, and keeps the button, when Refresh fails again', async () => {
				vi.spyOn(console, 'error').mockImplementation(() => {})
				save(answer())
				vi.mocked(api.data.query).mockRejectedValue(new Error('boom'))
				const { container } = renderView()
				await act(async () => {})
				await ask(container)

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
				})

				expect(screen.getByText('Refresh failed')).toBeTruthy()
				expect(screen.getByRole('button', { name: /Refresh/ })).toBeTruthy()
			})

			it('offers Refresh when a live query failed and nothing was saved', async () => {
				vi.spyOn(console, 'error').mockImplementation(() => {})
				vi.mocked(api.data.query).mockRejectedValueOnce(new Error('boom'))
				const { container } = renderView()
				await act(async () => {})
				await ask(container)
				expect(screen.getByText('Refresh failed')).toBeTruthy()

				vi.mocked(api.data.query).mockResolvedValue(answer())
				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
				})
				expect(screen.queryByText('Refresh failed')).toBeNull()
			})

			it('saves a live answer for the next visit', async () => {
				vi.mocked(api.data.query).mockResolvedValue(answer())
				const { container } = renderView()
				await act(async () => {})
				await ask(container)
				const saved = JSON.parse(
					localStorage.getItem(`maskin-loop-view:ws-1:${SPEC_KEY}`) ?? 'null',
				)
				expect(saved.result).toEqual(answer())
			})

			it('ignores a saved answer that is not a valid result', async () => {
				localStorage.setItem(`maskin-loop-view:ws-1:${SPEC_KEY}`, '{"at":1,"result":{"nope":true}}')
				vi.mocked(api.data.query).mockResolvedValue(answer())
				const { container } = renderView()
				await act(async () => {})
				expect(await askAndRead(container)).toEqual([answer()])
			})
		})

		it('shows no note for an answer that is complete', async () => {
			vi.mocked(api.data.query).mockResolvedValue(answer())
			const { container } = renderView()
			await act(async () => {})
			await ask(container)
			expect(screen.queryByText(/partial/)).toBeNull()
		})

		it('logs a failed live-refresh check, retries it, and says the view is stale once retries run out', async () => {
			vi.useFakeTimers()
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
			vi.mocked(api.data.query).mockResolvedValueOnce(answer())
			const { container } = renderView()
			await act(async () => {})
			await ask(container) // the view now holds an answer to compare against
			vi.mocked(api.data.query).mockRejectedValue(new Error('boom'))

			for (const listener of sseListeners) listener({ entity_type: 'task' })
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2_000)
			})
			expect(vi.mocked(api.data.query)).toHaveBeenCalledTimes(2)
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining('live refresh check failed'),
				expect.any(Error),
			)
			expect(screen.queryByText(/out of date/)).toBeNull()

			// The same check is tried again later, not dropped.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(5_000)
			})
			expect(vi.mocked(api.data.query)).toHaveBeenCalledTimes(3)

			await act(async () => {
				await vi.advanceTimersByTimeAsync(300_000)
			})
			expect(screen.getByText(/may be out of date/)).toBeTruthy()
		})

		it('keeps the view and says so, outside the frame, when a query fails', async () => {
			vi.mocked(api.data.query).mockRejectedValue(new Error('boom'))
			const { container, onFailure } = renderView()
			await act(async () => {})
			const first = latestFrame(container)

			await ask(container)

			expect(onFailure).not.toHaveBeenCalled()
			expect(latestFrame(container)).toBe(first)
			expect(screen.getByText(/could not be loaded/)).toBeTruthy()
		})

		it('says the view is stale when next-change lookups keep failing', async () => {
			vi.useFakeTimers()
			vi.spyOn(console, 'error').mockImplementation(() => {})
			vi.mocked(api.data.nextChange).mockRejectedValue(new Error('boom'))
			renderView()
			await act(async () => {})
			expect(screen.queryByText(/out of date/)).toBeNull()

			await act(async () => {
				await vi.advanceTimersByTimeAsync(300_000)
			})
			expect(screen.getByText(/may be out of date/)).toBeTruthy()
		})

		describe('live refresh', () => {
			/** Mounts the view after it has been asked for (and given) one answer. */
			async function withAnswer(first: object) {
				vi.useFakeTimers()
				vi.mocked(api.data.query).mockResolvedValueOnce(answer(first))
				const utils = renderView()
				await act(async () => {})
				await ask(utils.container)
				return utils
			}
			const event = () => {
				for (const listener of sseListeners) listener({ entity_type: 'task' })
			}
			const settle = () =>
				act(async () => {
					await vi.advanceTimersByTimeAsync(2_000)
				})

			it('replaces the frame when an event changed the answer', async () => {
				const { container } = await withAnswer({})
				const first = latestFrame(container)
				vi.mocked(api.data.query).mockResolvedValue(answer({ total: { count: 4, value: 4 } }))

				event()
				await settle()

				expect(latestFrame(container)).not.toBe(first)
			})

			it('keeps the old frame on screen until the replacement has drawn', async () => {
				const { container } = await withAnswer({})
				const first = latestFrame(container) as HTMLIFrameElement
				vi.mocked(api.data.query).mockResolvedValue(answer({ total: { count: 4, value: 4 } }))

				event()
				await settle()

				const frames = container.querySelectorAll('iframe')
				expect(frames).toHaveLength(2)
				expect(frames[0]).toBe(first)
				expect(first.className).not.toContain('invisible')
				expect(frames[1].className).toContain('invisible')

				const { view } = viewWindowOf(container)
				await act(async () => {
					window.dispatchEvent(
						new MessageEvent('message', {
							data: { type: VIEWER_DOC_SIZE_MESSAGE, h: 300 },
							source: view as unknown as Window,
						}),
					)
				})

				const after = container.querySelectorAll('iframe')
				expect(after).toHaveLength(1)
				expect(after[0].className).not.toContain('invisible')
			})

			it('leaves the frame alone when an event did not change the answer', async () => {
				const { container } = await withAnswer({})
				const first = latestFrame(container)
				vi.mocked(api.data.query).mockResolvedValue(answer())

				event()
				await settle()

				expect(vi.mocked(api.data.query)).toHaveBeenCalledTimes(2)
				expect(latestFrame(container)).toBe(first)
			})

			it('turns a burst of events into one check', async () => {
				await withAnswer({})
				vi.mocked(api.data.query).mockResolvedValue(answer())

				event()
				event()
				event()
				await settle()

				expect(vi.mocked(api.data.query)).toHaveBeenCalledTimes(2)
			})

			it('reloads the frame once when the server says the answer will change by itself', async () => {
				vi.mocked(api.data.nextChange).mockResolvedValueOnce({ in_ms: 10_000 })
				vi.useFakeTimers()
				const { container } = renderView()
				await act(async () => {})
				const first = latestFrame(container)

				await act(async () => {
					await vi.advanceTimersByTimeAsync(10_999)
				})
				expect(latestFrame(container)).toBe(first)

				await act(async () => {
					await vi.advanceTimersByTimeAsync(2)
				})
				expect(latestFrame(container)).not.toBe(first)
			})
		})

		it('logs a failed next-change lookup and looks again instead of going without a timer', async () => {
			vi.useFakeTimers()
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
			vi.mocked(api.data.nextChange).mockRejectedValueOnce(new Error('boom'))
			renderView()
			await act(async () => {})
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining('next-change lookup failed'),
				expect.any(Error),
			)
			expect(vi.mocked(api.data.nextChange)).toHaveBeenCalledTimes(1)

			await act(async () => {
				await vi.advanceTimersByTimeAsync(5_000)
			})
			expect(vi.mocked(api.data.nextChange)).toHaveBeenCalledTimes(2)
		})
	})

	describe('list sources', () => {
		const LIST_VIEW = `<html><head></head><body>
<script id="maskin-sources" type="application/json">{"opps":{"list":"opportunities"},"by_status":{"type":"task","group_by":"status"}}</script>
<h1>Pipeline</h1></body></html>`

		it('refuses a list on the loop page: no rows, no query, and the rest of the view still works', async () => {
			useFileMock.mockReturnValue({
				data: file({ content: LIST_VIEW }),
				isLoading: false,
				isError: false,
			})
			vi.mocked(api.data.query).mockResolvedValue({ total: { count: 1, value: 1 } } as never)
			const { container, onFailure } = renderView()
			const { view } = viewWindowOf(container)

			await act(async () => {
				window.dispatchEvent(
					new MessageEvent('message', {
						data: { type: BRIDGE_QUERY_MESSAGE, id: 1, name: 'opps' },
						source: view as unknown as Window,
					}),
				)
			})

			expect(onFailure).not.toHaveBeenCalled()
			expect(api.data.query).not.toHaveBeenCalled()
			expect(view.postMessage).toHaveBeenCalledWith(
				{
					type: 'maskin:bridge:result',
					id: 1,
					error: "This view asks for data the app doesn't offer",
				},
				'*',
			)
		})
	})
})
