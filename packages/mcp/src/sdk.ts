// The one place packages/mcp touches the MCP SDK. Every other file imports
// SDK symbols from here, and tests mock this single module instead of one
// path per SDK entry point. Keeping the surface in one file means a major SDK
// upgrade changes these re-exports, not the call sites.
export {
	RESOURCE_MIME_TYPE,
	registerAppResource,
	registerAppTool,
} from '@modelcontextprotocol/ext-apps/server'
export { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
export { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
export { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
export { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
export { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
