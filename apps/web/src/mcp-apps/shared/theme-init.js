;(() => {
	const t = localStorage.getItem('ai-native-mcp-theme')
	if (t === 'light') return
	document.documentElement.classList.add('dark')
})()
