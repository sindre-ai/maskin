import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'maskin-mcp-theme'

function getTheme(): 'light' | 'dark' {
	if (typeof window === 'undefined') return 'dark'
	const stored = localStorage.getItem(STORAGE_KEY)
	if (stored === 'light') return 'light'
	return 'dark'
}

function SunIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			role="img"
			aria-label="Sun"
		>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2" />
			<path d="M12 20v2" />
			<path d="m4.93 4.93 1.41 1.41" />
			<path d="m17.66 17.66 1.41 1.41" />
			<path d="M2 12h2" />
			<path d="M20 12h2" />
			<path d="m6.34 17.66-1.41 1.41" />
			<path d="m19.07 4.93-1.41 1.41" />
		</svg>
	)
}

function MoonIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			role="img"
			aria-label="Moon"
		>
			<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
		</svg>
	)
}

export function ThemeToggle() {
	const [theme, setTheme] = useState<'light' | 'dark'>(getTheme)

	useEffect(() => {
		document.documentElement.classList.toggle('dark', theme === 'dark')
		localStorage.setItem(STORAGE_KEY, theme)
	}, [theme])

	const toggle = useCallback(() => {
		setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
	}, [])

	return (
		<button
			type="button"
			onClick={toggle}
			className="fixed top-2 right-2 z-50 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
			aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
		>
			{theme === 'dark' ? <SunIcon /> : <MoonIcon />}
		</button>
	)
}
