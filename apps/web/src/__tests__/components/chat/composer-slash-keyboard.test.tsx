import { Composer } from '@/components/chat/chat'
import { EMPTY_CHAT_SELECTION } from '@/lib/chat-selection'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildObjectResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

// The composer's `/` picker only wires keyboard-from-composer nav when the
// `chat-slash-picker-v2` flag is on. Force it on for the entire file so the
// unified branch executes without touching the real flag cache.
vi.mock('@/hooks/use-feature-flag', () => ({
	useFeatureFlag: (flagId: string) => flagId === 'chat-slash-picker-v2',
}))

vi.mock('@/hooks/use-files', () => ({
	useUploadFile: () => vi.fn(),
}))

vi.mock('@/lib/file-utils', () => ({
	readFileAsBase64: async () => '',
}))

vi.mock('@/components/chat/slash-picker', () => ({
	SlashPicker: () => null,
}))

vi.mock('@/lib/analytics', () => ({
	deriveEntryAgentRole: () => 'coach',
	trackSpecialistSummonedManually: () => {},
	trackChatObjectReferenceCreated: () => {},
	trackChatSlashPickerError: () => {},
}))

vi.mock('@/lib/api', () => ({
	api: {
		objects: {
			list: vi.fn(),
			search: vi.fn(),
		},
	},
}))

import { api } from '@/lib/api'

const RECENT = [
	buildObjectResponse({ id: 'obj-1', title: 'First recent bet', type: 'bet' }),
	buildObjectResponse({ id: 'obj-2', title: 'Second recent task', type: 'task' }),
	buildObjectResponse({ id: 'obj-3', title: 'Third recent insight', type: 'insight' }),
]

function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
	const onDispatchSelection = vi.fn()
	const props = {
		workspaceId: 'ws-test',
		onSend: vi.fn().mockResolvedValue(undefined),
		disabled: false,
		pending: false,
		surface: 'sheet' as const,
		placeholder: 'Message',
		selection: EMPTY_CHAT_SELECTION,
		onDispatchSelection,
		onRemoveAgent: vi.fn(),
		onRemoveObject: vi.fn(),
		onRemoveNotification: vi.fn(),
		onRemoveFile: vi.fn(),
		...overrides,
	}
	const result = render(<Composer {...props} />, { wrapper: createWorkspaceWrapper() })
	return { ...result, onDispatchSelection }
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(api.objects.list).mockResolvedValue(RECENT)
	vi.mocked(api.objects.search).mockResolvedValue(RECENT)
})

describe('Composer unified `/` picker — keyboard from the textarea', () => {
	it("ArrowDown then Enter selects the picker's second reference row", async () => {
		const { onDispatchSelection } = renderComposer()
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

		// Open the picker by typing `/`. The composer's onChange also reads the
		// caret, which jsdom keeps in sync with `value.length` after fireEvent.
		fireEvent.change(textarea, { target: { value: '/' } })

		// Wait for the reference rows to render — the picker fires `list_objects`
		// on empty query and paints the recent list.
		await screen.findByText('First recent bet')
		await screen.findByText('Second recent task')

		// ArrowDown moves the picker's active row from index 0 to 1 via the
		// composer's imperative-handle intercept. Enter fires selectActive(),
		// which routes back through the composer's `onDispatchSelection`.
		fireEvent.keyDown(textarea, { key: 'ArrowDown' })
		fireEvent.keyDown(textarea, { key: 'Enter' })

		await waitFor(() =>
			expect(onDispatchSelection).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'add_object',
					object: expect.objectContaining({ id: 'obj-2', title: 'Second recent task' }),
				}),
			),
		)
	})

	it('publishes aria-activedescendant on the textarea while the picker is open', async () => {
		renderComposer()
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: '/' } })
		await screen.findByText('First recent bet')
		await waitFor(() => {
			expect(textarea.getAttribute('aria-activedescendant')).toBeTruthy()
		})
		// The active-descendant id must resolve to an actual option in the DOM.
		const activeId = textarea.getAttribute('aria-activedescendant') as string
		const activeEl = document.getElementById(activeId)
		expect(activeEl).not.toBeNull()
		expect(activeEl?.getAttribute('role')).toBe('option')
	})

	it('Enter on a create row seeds the CreatePicker input with the current query', async () => {
		renderComposer()
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
		// Query is a single-word run — the picker's trigger regex closes on
		// whitespace, matching the shipped `/` UX.
		vi.mocked(api.objects.search).mockResolvedValueOnce([])
		fireEvent.change(textarea, { target: { value: '/rollout' } })
		await screen.findByText(/Create task "rollout"/)

		// The picker's active row when reference results are empty is the first
		// create row (Create task). Enter fires selectActive() on it — no need
		// to arrow down.
		fireEvent.keyDown(textarea, { key: 'Enter' })

		// The composer opens the shared CreatePicker with `defaultText`
		// prefilled — its title input renders the query verbatim.
		const titleInput = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Title' })
		expect(titleInput.value).toBe('rollout')
	})

	it('ArrowUp from the top row stays put (no wrap, no crash)', async () => {
		const { onDispatchSelection } = renderComposer()
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: '/' } })
		await screen.findByText('First recent bet')
		// Repeated ArrowUp at the top is a no-op (index clamps to 0). Enter
		// then selects the first row.
		fireEvent.keyDown(textarea, { key: 'ArrowUp' })
		fireEvent.keyDown(textarea, { key: 'ArrowUp' })
		fireEvent.keyDown(textarea, { key: 'Enter' })
		await waitFor(() =>
			expect(onDispatchSelection).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'add_object',
					object: expect.objectContaining({ id: 'obj-1' }),
				}),
			),
		)
	})

	it('Enter does not submit the message while the picker is open', async () => {
		const onSend = vi.fn().mockResolvedValue(undefined)
		renderComposer({ onSend })
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: '/' } })
		await screen.findByText('First recent bet')
		// Enter while the picker owns keyboard would submit under the pre-fix
		// path (it was swallowed) — with the fix it fires selectActive instead.
		// Either way, `onSend` must not fire.
		fireEvent.keyDown(textarea, { key: 'Enter' })
		// Give any queued work a chance to complete.
		await act(async () => {
			await Promise.resolve()
		})
		expect(onSend).not.toHaveBeenCalled()
	})
})
