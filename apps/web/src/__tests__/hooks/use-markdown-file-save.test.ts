import {
	FileConflictError,
	FileRetryableError,
	type FileSaveClient,
	useMarkdownFileSave,
} from '@/hooks/use-markdown-file-save'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

function setup(overrides: Partial<FileSaveClient> = {}) {
	const save = vi.fn<FileSaveClient['save']>(async () => ({ hash: 'h1' }))
	const fetchLatest = vi.fn<FileSaveClient['fetchLatest']>(async () => ({
		text: 'agent text',
		hash: 'hA',
	}))
	const client: FileSaveClient = { save, fetchLatest, ...overrides }
	const onConflictShown = vi.fn()
	let current = 'original'
	const hook = renderHook(() =>
		useMarkdownFileSave({
			client,
			initialText: 'original',
			initialHash: 'h0',
			readText: () => current,
			savedForm: async (text) => text.trim(),
			onConflictShown,
		}),
	)
	const edit = (text: string) => {
		current = text
		act(() => hook.result.current.markEdited())
	}
	const advance = (ms: number) =>
		act(async () => {
			await vi.advanceTimersByTimeAsync(ms)
		})
	return { hook, client, save, fetchLatest, onConflictShown, edit, advance }
}

describe('useMarkdownFileSave', () => {
	it('sends nothing when the file was opened and not edited', async () => {
		const { save, advance } = setup()
		await advance(3000)
		expect(save).not.toHaveBeenCalled()
	})

	it('saves 500ms after an edit and sends the hash the file was loaded with', async () => {
		const { save, edit, advance } = setup()
		edit('changed')
		await advance(499)
		expect(save).not.toHaveBeenCalled()
		await advance(1)
		expect(save).toHaveBeenCalledTimes(1)
		expect(save).toHaveBeenCalledWith('changed', 'h0')
	})

	it('sends nothing when an edit is undone before the save', async () => {
		const { save, edit, advance } = setup()
		edit('changed')
		edit('original')
		await advance(3000)
		expect(save).not.toHaveBeenCalled()
	})

	it('keeps one save in flight and sends the next with the hash from the previous reply', async () => {
		let release: (value: { hash: string }) => void = () => undefined
		const first = new Promise<{ hash: string }>((resolve) => {
			release = resolve
		})
		const save = vi
			.fn<FileSaveClient['save']>()
			.mockReturnValueOnce(first)
			.mockResolvedValue({ hash: 'h2' })
		const { edit, advance } = setup({ save })

		edit('one')
		await advance(500)
		expect(save).toHaveBeenCalledTimes(1)

		edit('two')
		await advance(500)
		expect(save).toHaveBeenCalledTimes(1)

		await act(async () => {
			release({ hash: 'h1' })
			await vi.advanceTimersByTimeAsync(0)
		})
		expect(save).toHaveBeenCalledTimes(2)
		expect(save).toHaveBeenLastCalledWith('two', 'h1')
	})

	it('pauses on a 409, shows the conflict and never resends on its own', async () => {
		const save = vi.fn<FileSaveClient['save']>().mockRejectedValue(new FileConflictError())
		const { hook, fetchLatest, onConflictShown, edit, advance } = setup({ save })

		edit('changed')
		await advance(500)
		expect(fetchLatest).toHaveBeenCalledTimes(1)
		expect(hook.result.current.status).toBe('conflict')
		expect(hook.result.current.conflict).toEqual({ text: 'agent text', hash: 'hA' })
		expect(onConflictShown).toHaveBeenCalledTimes(1)

		edit('changed more')
		await advance(10000)
		expect(save).toHaveBeenCalledTimes(1)
	})

	it('carries on without a banner when the latest file is the same in the editor saved form', async () => {
		const save = vi
			.fn<FileSaveClient['save']>()
			.mockRejectedValueOnce(new FileConflictError())
			.mockResolvedValue({ hash: 'h3' })
		const fetchLatest = vi.fn<FileSaveClient['fetchLatest']>(async () => ({
			text: 'changed \n',
			hash: 'hA',
		}))
		const { hook, onConflictShown, edit, advance } = setup({ save, fetchLatest })

		edit('changed')
		await advance(500)
		expect(hook.result.current.status).toBe('idle')
		expect(onConflictShown).not.toHaveBeenCalled()

		edit('changed again')
		await advance(500)
		expect(save).toHaveBeenLastCalledWith('changed again', 'hA')
	})

	it('retries a timeout after 1s, 2s and 4s and then shows the failed banner', async () => {
		const save = vi.fn<FileSaveClient['save']>().mockRejectedValue(new FileRetryableError())
		const { hook, edit, advance } = setup({ save })

		edit('changed')
		await advance(500)
		expect(save).toHaveBeenCalledTimes(1)
		await advance(1000)
		expect(save).toHaveBeenCalledTimes(2)
		await advance(2000)
		expect(save).toHaveBeenCalledTimes(3)
		await advance(4000)
		expect(save).toHaveBeenCalledTimes(4)
		expect(hook.result.current.status).toBe('failed')
		expect(save).toHaveBeenNthCalledWith(4, 'changed', 'h0')
	})

	it('shows the failed banner straight away for any other error and retries on request', async () => {
		const save = vi
			.fn<FileSaveClient['save']>()
			.mockRejectedValueOnce(new Error('Network error'))
			.mockResolvedValue({ hash: 'h1' })
		const { hook, edit, advance } = setup({ save })

		edit('changed')
		await advance(500)
		expect(hook.result.current.status).toBe('failed')

		act(() => hook.result.current.retry())
		await advance(500)
		expect(save).toHaveBeenCalledTimes(2)
		expect(hook.result.current.status).toBe('idle')
	})

	it('keeps mine and overwrites with the latest hash only after the click', async () => {
		const save = vi
			.fn<FileSaveClient['save']>()
			.mockRejectedValueOnce(new FileConflictError())
			.mockResolvedValue({ hash: 'h5' })
		const { hook, edit, advance } = setup({ save })

		edit('changed')
		await advance(500)
		expect(save).toHaveBeenCalledTimes(1)

		act(() => hook.result.current.keepMineAndOverwrite())
		await advance(0)
		expect(save).toHaveBeenCalledTimes(2)
		expect(save).toHaveBeenLastCalledWith('changed', 'hA')
		expect(hook.result.current.status).toBe('idle')
	})

	it('loads the new version without saving', async () => {
		const save = vi.fn<FileSaveClient['save']>().mockRejectedValue(new FileConflictError())
		const { hook, edit, advance } = setup({ save })

		edit('changed')
		await advance(500)
		act(() => hook.result.current.loadNewVersion())

		expect(hook.result.current.status).toBe('idle')
		expect(hook.result.current.baseText).toBe('agent text')
		expect(hook.result.current.editorKey).toBe(1)
		await advance(5000)
		expect(save).toHaveBeenCalledTimes(1)
	})
})
