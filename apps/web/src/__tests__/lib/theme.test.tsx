import { ThemeProvider, useTheme } from '@/lib/theme'
import { renderHook, act } from '@testing-library/react'
import React from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let listeners: Array<(e: MediaQueryListEvent) => void> = []
const mockMatchMedia = vi.fn()

const wrapper = ({ children }: { children: ReactNode }) =>
	React.createElement(ThemeProvider, null, children)

beforeEach(() => {
	localStorage.clear()
	listeners = []
	document.documentElement.classList.remove('dark')

	mockMatchMedia.mockImplementation((query: string) => ({
		matches: false,
		media: query,
		addEventListener: (_event: string, handler: (e: MediaQueryListEvent) => void) => {
			listeners.push(handler)
		},
		removeEventListener: (_event: string, handler: (e: MediaQueryListEvent) => void) => {
			listeners = listeners.filter((l) => l !== handler)
		},
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}))

	vi.stubGlobal('matchMedia', mockMatchMedia)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('ThemeProvider', () => {
	it('defaults to light when no stored theme', () => {
		const { result } = renderHook(() => useTheme(), { wrapper })
		expect(result.current.theme).toBe('light')
		expect(result.current.resolvedTheme).toBe('light')
	})

	it('reads stored theme from localStorage', () => {
		localStorage.setItem('ai-native-theme', 'dark')
		const { result } = renderHook(() => useTheme(), { wrapper })
		expect(result.current.theme).toBe('dark')
		expect(result.current.resolvedTheme).toBe('dark')
	})

	it('persists theme to localStorage via setTheme', () => {
		const { result } = renderHook(() => useTheme(), { wrapper })

		act(() => {
			result.current.setTheme('dark')
		})

		expect(localStorage.getItem('ai-native-theme')).toBe('dark')
	})

	it('applies dark class to documentElement when dark', () => {
		const { result } = renderHook(() => useTheme(), { wrapper })

		act(() => {
			result.current.setTheme('dark')
		})

		expect(document.documentElement.classList.contains('dark')).toBe(true)
	})

	it('removes dark class when switching to light', () => {
		localStorage.setItem('ai-native-theme', 'dark')
		const { result } = renderHook(() => useTheme(), { wrapper })

		act(() => {
			result.current.setTheme('light')
		})

		expect(document.documentElement.classList.contains('dark')).toBe(false)
	})

	it('resolves system theme based on matchMedia preference', () => {
		mockMatchMedia.mockImplementation((query: string) => ({
			matches: true,
			media: query,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			onchange: null,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}))

		localStorage.setItem('ai-native-theme', 'system')
		const { result } = renderHook(() => useTheme(), { wrapper })
		expect(result.current.theme).toBe('system')
		expect(result.current.resolvedTheme).toBe('dark')
	})

	it('listens for OS preference changes in system mode', () => {
		localStorage.setItem('ai-native-theme', 'system')
		const { result } = renderHook(() => useTheme(), { wrapper })

		expect(result.current.resolvedTheme).toBe('light')

		act(() => {
			for (const listener of listeners) {
				listener({ matches: true } as MediaQueryListEvent)
			}
		})

		expect(result.current.resolvedTheme).toBe('dark')
		expect(document.documentElement.classList.contains('dark')).toBe(true)
	})
})

describe('useTheme', () => {
	it('throws error outside ThemeProvider', () => {
		expect(() => {
			renderHook(() => useTheme())
		}).toThrow('useTheme must be used within ThemeProvider')
	})
})
