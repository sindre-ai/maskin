/**
 * Display-only name for a tool call: `mcp__maskin__desktop_run` → `Desktop run`,
 * `mcp__github-sindre-ai__get_file_contents` → `Get file contents`, `Read` → `Read`.
 * Drops the `mcp__<server>__` prefix and turns underscores and hyphens into spaces,
 * and capitalises the first letter (the rest is left as is).
 * The raw tool name stays untouched everywhere it is stored or matched on.
 */
export function formatToolName(name: string): string {
	let tool = name
	if (name.startsWith('mcp__')) {
		const rest = name.slice('mcp__'.length)
		const serverEnd = rest.indexOf('__')
		tool = serverEnd === -1 ? rest : rest.slice(serverEnd + 2)
	}
	const plain = tool.replace(/[_-]+/g, ' ').trim()
	return plain ? plain.charAt(0).toUpperCase() + plain.slice(1) : name
}
