import { useEffect, useState } from 'react'

/** Tracks a CSS media query. False on the server and until the first effect. */
export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(false)
	useEffect(() => {
		const mql = window.matchMedia(query)
		const onChange = () => setMatches(mql.matches)
		onChange()
		mql.addEventListener('change', onChange)
		return () => mql.removeEventListener('change', onChange)
	}, [query])
	return matches
}
