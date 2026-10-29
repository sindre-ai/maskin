/**
 * Display-only name for a tool call: `mcp__maskin__desktop_run` → `desktop run`,
 * `mcp__github-sindre-ai__get_file_contents` → `get file contents`, `Read` → `Read`.
 * Drops the `mcp__<server>__` prefix and turns underscores and hyphens into spaces.
 * The raw tool name stays untouched everywhere it is stored or matched on.
 */
export function formatToolName(name: string): string {
	let tool = name
	if (name.startsWith('mcp__')) {
		const rest = name.slice('mcp__'.length)
		const serverEnd = rest.indexOf('__')
		tool = serverEnd === -1 ? rest : rest.slice(serverEnd + 2)
	}
	return tool.replace(/[_-]+/g, ' ').trim() || name
}
