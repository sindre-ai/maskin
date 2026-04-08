;(() => {
	// Migrate old key
	const old = localStorage.getItem('ai-native-mcp-theme')
	if (old && !localStorage.getItem('maskin-mcp-theme')) {
		localStorage.setItem('maskin-mcp-theme', old)
		localStorage.removeItem('ai-native-mcp-theme')
	}
	const t = localStorage.getItem('maskin-mcp-theme')
	if (t === 'light') return
	document.documentElement.classList.add('dark')
})()
