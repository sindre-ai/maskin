// Raw HTTP helpers for the conformance matrix. No SDK: the point of the raw
// styles is to see exactly what a client that does not use the SDK sees.

import type { Observed, Target } from './types'

export const MODERN_VERSION = '2026-07-28'
export const LEGACY_VERSION = '2025-06-18'

// Reserved _meta keys of the 2026-07-28 per-request envelope. Constants of the
// spec (the SDK exports the same strings), spelled out here so the raw modern
// style does not import the SDK.
export const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion'
export const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo'
export const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities'

export function endpoint(target: Target): string {
	return `${target.baseUrl.replace(/\/$/, '')}/mcp`
}

export interface SendOptions {
	headers?: Record<string, string>
	/** Header names (any case) to drop after defaults are applied. */
	omitHeaders?: string[]
	noAuth?: boolean
}

function applyOptions(
	target: Target,
	defaults: Record<string, string>,
	options: SendOptions,
): Record<string, string> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Accept: 'application/json, text/event-stream',
		'X-Workspace-Id': target.workspaceId,
		...defaults,
		...options.headers,
	}
	if (!options.noAuth) headers.Authorization = `Bearer ${target.apiKey}`
	for (const name of options.omitHeaders ?? []) {
		for (const key of Object.keys(headers)) {
			if (key.toLowerCase() === name.toLowerCase()) delete headers[key]
		}
	}
	return headers
}

export async function observe(res: Response): Promise<Observed> {
	const text = await res.text()
	let json: unknown
	try {
		json = text ? JSON.parse(text) : undefined
	} catch {
		json = undefined
	}
	const headers: Record<string, string> = {}
	res.headers.forEach((value, key) => {
		headers[key.toLowerCase()] = value
	})
	return { status: res.status, contentType: res.headers.get('content-type'), headers, text, json }
}

/** POST an arbitrary body (string bodies are sent verbatim, for malformed JSON). */
export async function post(
	target: Target,
	body: unknown,
	options: SendOptions = {},
): Promise<Observed> {
	const res = await fetch(endpoint(target), {
		method: 'POST',
		headers: applyOptions(target, {}, options),
		body: typeof body === 'string' ? body : JSON.stringify(body),
	})
	return observe(res)
}

/** GET or DELETE with the same default headers. */
export async function bare(
	target: Target,
	method: 'GET' | 'DELETE',
	options: SendOptions = {},
): Promise<Observed> {
	const res = await fetch(endpoint(target), {
		method,
		headers: applyOptions(target, {}, options),
	})
	return observe(res)
}

let nextId = 1

export function legacyRequest(method: string, params?: Record<string, unknown>) {
	return { jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) }
}

/** Legacy initialize body, the way a 2025-era client sends it. */
export function legacyInitialize() {
	return legacyRequest('initialize', {
		protocolVersion: LEGACY_VERSION,
		capabilities: {},
		clientInfo: { name: 'maskin-conformance', version: '1' },
	})
}

export function modernEnvelope(version: string = MODERN_VERSION): Record<string, unknown> {
	return {
		[PROTOCOL_VERSION_META_KEY]: version,
		[CLIENT_INFO_META_KEY]: { name: 'maskin-conformance', version: '1' },
		[CLIENT_CAPABILITIES_META_KEY]: {},
	}
}

export interface ModernOptions extends SendOptions {
	/** Version claimed in both the header and the envelope. */
	version?: string
	/** Leave the _meta envelope out of the body. */
	noEnvelope?: boolean
}

/** The value the Mcp-Name header must carry for a method, or undefined if none. */
function mcpName(method: string, params: Record<string, unknown>): string | undefined {
	if (method === 'tools/call' || method === 'prompts/get') return String(params.name)
	if (method === 'resources/read') return String(params.uri)
	return undefined
}

/** Build a modern (2026-07-28) request: required headers plus the _meta envelope. */
export function modernRequest(
	method: string,
	params: Record<string, unknown> = {},
	options: ModernOptions = {},
) {
	const version = options.version ?? MODERN_VERSION
	const name = mcpName(method, params)
	const headers: Record<string, string> = {
		'MCP-Protocol-Version': version,
		'Mcp-Method': method,
		...(name !== undefined ? { 'Mcp-Name': name } : {}),
	}
	const body = {
		jsonrpc: '2.0',
		id: nextId++,
		method,
		params: options.noEnvelope ? params : { ...params, _meta: modernEnvelope(version) },
	}
	return { body, headers }
}

export async function postModern(
	target: Target,
	method: string,
	params: Record<string, unknown> = {},
	options: ModernOptions = {},
): Promise<Observed> {
	const { body, headers } = modernRequest(method, params, options)
	return post(target, body, { ...options, headers: { ...headers, ...options.headers } })
}

export interface JsonRpcBody {
	jsonrpc?: string
	id?: unknown
	result?: Record<string, unknown>
	error?: { code: number; message: string; data?: Record<string, unknown> }
}

export function rpc(observed: Observed): JsonRpcBody {
	if (observed.json === null || typeof observed.json !== 'object' || Array.isArray(observed.json)) {
		throw new Error(
			`expected a JSON-RPC object, got ${observed.status} ${observed.text.slice(0, 200)}`,
		)
	}
	return observed.json as JsonRpcBody
}

/** The result object of a successful JSON-RPC response, or a readable throw. */
export function rpcResult(observed: Observed): Record<string, unknown> {
	const body = rpc(observed)
	if (!body.result) {
		throw new Error(
			`expected a JSON-RPC result, got ${observed.status} ${observed.text.slice(0, 300)}`,
		)
	}
	return body.result
}
