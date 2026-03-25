import { createContext, useCallback, useContext, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'

interface ThemeContextValue {
	theme: Theme
	resolvedTheme: 'light' | 'dark'
	setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

const STORAGE_KEY = 'maskin-theme'

function getSystemTheme(): 'light' | 'dark' {
	if (typeof window === 'undefined') return 'light'
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function getStoredTheme(): Theme {
	if (typeof window === 'undefined') return 'light'
	return (localStorage.getItem(STORAGE_KEY) as Theme) || 'light'
}

function applyTheme(resolved: 'light' | 'dark') {
	document.documentElement.classList.toggle('dark', resolved === 'dark')
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
	const [theme, setThemeState] = useState<Theme>(getStoredTheme)
	const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() =>
		theme === 'system' ? getSystemTheme() : theme,
	)

	const setTheme = useCallback((newTheme: Theme) => {
		setThemeState(newTheme)
		localStorage.setItem(STORAGE_KEY, newTheme)
	}, [])

	// Apply theme class whenever theme changes
	useEffect(() => {
		const resolved = theme === 'system' ? getSystemTheme() : theme
		setResolvedTheme(resolved)
		applyTheme(resolved)
	}, [theme])

	// Listen for system preference changes when in 'system' mode
	useEffect(() => {
		if (theme !== 'system') return

		const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
		const handler = (e: MediaQueryListEvent) => {
			const resolved = e.matches ? 'dark' : 'light'
			setResolvedTheme(resolved)
			applyTheme(resolved)
		}

		mediaQuery.addEventListener('change', handler)
		return () => mediaQuery.removeEventListener('change', handler)
	}, [theme])

	return (
		<ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
			{children}
		</ThemeContext.Provider>
	)
}

export function useTheme() {
	const context = useContext(ThemeContext)
	if (!context) throw new Error('useTheme must be used within ThemeProvider')
	return context
}
