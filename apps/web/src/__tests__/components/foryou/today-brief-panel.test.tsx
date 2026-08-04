import { TodayBriefPanel } from '@/components/foryou/today-brief-panel'
import { TodayBriefProvider, useTodayBrief } from '@/lib/today-brief-context'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let matchesDesktop = true
const listeners = new Set<() => void>()

beforeEach(() => {
	matchesDesktop = true
	listeners.clear()
	vi.stubGlobal(
		'matchMedia',
		vi.fn().mockImplementation((query: string) => {
			const isMinWidth1024 = query === '(min-width: 1024px)'
			const isMaxWidth1024 = query === '(max-width: 1024px)'
			return {
				matches: isMinWidth1024 ? matchesDesktop : isMaxWidth1024 ? !matchesDesktop : false,
				media: query,
				addEventListener: (_: string, cb: () => void) => listeners.add(cb),
				removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
				addListener: () => {},
				removeListener: () => {},
				dispatchEvent: () => false,
				onchange: null,
			}
		}),
	)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

function setDesktop(next: boolean) {
	matchesDesktop = next
	Object.defineProperty(window, 'innerWidth', {
		writable: true,
		configurable: true,
		value: next ? 1280 : 375,
	})
	act(() => {
		for (const cb of listeners) cb()
	})
}

function OpenTrigger() {
	const { setOpen } = useTodayBrief()
	return (
		<button type="button" onClick={() => setOpen(true)}>
			open
		</button>
	)
}

function renderPanel(desktop: boolean) {
	setDesktop(desktop)
	return render(
		<TodayBriefProvider>
			<OpenTrigger />
			<TodayBriefPanel />
		</TodayBriefProvider>,
	)
}

describe('TodayBriefPanel', () => {
	it('renders nothing when closed on desktop', () => {
		renderPanel(true)
		expect(screen.queryByRole('complementary', { name: /today's brief/i })).toBeNull()
	})

	it('renders as an inline right-rail with audio + mentioned placeholders when opened on desktop', () => {
		renderPanel(true)
		fireEvent.click(screen.getByText('open'))
		const rail = screen.getByTestId('todays-brief-panel')
		expect(rail).toBeInTheDocument()
		expect(rail).toHaveAttribute('data-mode', 'rail')
		expect(rail.className).toContain('w-[340px]')
		expect(rail.className).toContain('border-l')
		expect(
			screen.getByText(/today's brief will appear here once the briefing pipeline lands/i),
		).toBeInTheDocument()
		expect(
			screen.getByText(/mentioned items will appear here once the briefing pipeline lands/i),
		).toBeInTheDocument()
	})

	it('opens as a right-side Sheet overlay below 1024', () => {
		renderPanel(false)
		fireEvent.click(screen.getByText('open'))
		const sheet = screen.getByTestId('todays-brief-panel')
		expect(sheet).toHaveAttribute('data-mode', 'sheet')
		expect(sheet.getAttribute('role')).toBe('dialog')
		expect(
			screen.getByText(/today's brief will appear here once the briefing pipeline lands/i),
		).toBeInTheDocument()
	})

	it('closes via the header close button on desktop', () => {
		renderPanel(true)
		fireEvent.click(screen.getByText('open'))
		fireEvent.click(screen.getByRole('button', { name: /close today's brief/i }))
		expect(screen.queryByRole('complementary', { name: /today's brief/i })).toBeNull()
	})
})

describe('useTodayBrief', () => {
	it('throws outside the provider', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
		expect(() => render(<OpenTrigger />)).toThrow(/TodayBriefProvider/)
		spy.mockRestore()
	})
})
