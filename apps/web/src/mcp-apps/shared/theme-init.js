;(() => {
	const t = localStorage.getItem('maskin-mcp-theme')
	if (t === 'light') return
	document.documentElement.classList.add('dark')
})()
