import { PageHeaderProvider, usePageHeader } from '@/lib/page-header-context'
import { render, renderHook, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

const wrapper = ({ children }: { children: ReactNode }) =>
	React.createElement(PageHeaderProvider, null, children)

describe('usePageHeader', () => {
	it('returns default context with undefined actions', () => {
		const { result } = renderHook(() => usePageHeader())
		expect(result.current.actions).toBeUndefined()
		expect(typeof result.current.setActions).toBe('function')
	})

	it('allows setting actions via setActions', () => {
		const { result } = renderHook(() => usePageHeader(), { wrapper })

		act(() => {
			result.current.setActions(React.createElement('button', null, 'Save'))
		})

		expect(result.current.actions).toBeTruthy()
	})

	it('updates actions visible to consumers', async () => {
		const user = userEvent.setup()

		function Consumer() {
			const { actions } = usePageHeader()
			return React.createElement('div', null, actions)
		}

		function Setter() {
			const { setActions } = usePageHeader()
			return React.createElement(
				'button',
				{ onClick: () => setActions(React.createElement('span', null, 'Action Content')) },
				'Set',
			)
		}

		render(
			React.createElement(
				PageHeaderProvider,
				null,
				React.createElement(Consumer),
				React.createElement(Setter),
			),
		)

		await user.click(screen.getByText('Set'))
		expect(screen.getByText('Action Content')).toBeInTheDocument()
	})

	it('returns a stable setActions reference across renders', () => {
		const refs: Array<(actions: ReactNode) => void> = []

		function Collector() {
			const { setActions } = usePageHeader()
			refs.push(setActions)
			return null
		}

		const { rerender } = render(
			React.createElement(PageHeaderProvider, null, React.createElement(Collector)),
		)

		rerender(
			React.createElement(PageHeaderProvider, null, React.createElement(Collector)),
		)

		expect(refs.length).toBeGreaterThanOrEqual(2)
		expect(refs[0]).toBe(refs[1])
	})
})
