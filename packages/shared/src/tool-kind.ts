const READ_PREFIXES = ['get_', 'list_', 'read_', 'search_', 'find_']

/**
 * Default read/write kind for a tool the MCP probe discovered. A guess from the
 * name only; a kind the extension declares itself always wins over this.
 */
export function classifyToolKind(name: string): 'read' | 'write' {
	return READ_PREFIXES.some((p) => name.startsWith(p)) ? 'read' : 'write'
}

/** Declared kind when the tool has one, otherwise the name-based default. */
export function resolveToolKind(tool: { name: string; kind?: 'read' | 'write' }): 'read' | 'write' {
	return tool.kind ?? classifyToolKind(tool.name)
}
