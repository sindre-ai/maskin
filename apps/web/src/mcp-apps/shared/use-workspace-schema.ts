import { useCallback, useEffect, useState } from 'react'
import { useCallTool, useToolResult } from './mcp-app-provider'
import { safeParseJson } from './parse'

export type SchemaFieldType = 'text' | 'number' | 'date' | 'enum' | 'boolean' | 'json'

export interface SchemaFieldDef {
	name: string
	type: SchemaFieldType
	required: boolean
	values?: string[]
}

export interface TypeSchema {
	display_name: string
	statuses: string[]
	fields: SchemaFieldDef[]
}

export interface WorkspaceSchema {
	workspace_id: string
	workspace_name: string
	relationship_types: string[]
	types: Record<string, TypeSchema>
}

interface ToolContent {
	type: string
	text?: string
}

const KNOWN_FIELD_TYPES: SchemaFieldType[] = ['text', 'number', 'date', 'enum', 'boolean', 'json']

function isFieldType(t: unknown): t is SchemaFieldType {
	return typeof t === 'string' && (KNOWN_FIELD_TYPES as string[]).includes(t)
}

function normalizeField(raw: unknown): SchemaFieldDef | null {
	if (typeof raw !== 'object' || raw === null) return null
	const r = raw as Record<string, unknown>
	const name = typeof r.name === 'string' ? r.name : null
	if (!name) return null
	const type = isFieldType(r.type) ? r.type : 'text'
	const required = r.required === true
	const values = Array.isArray(r.values)
		? r.values.filter((v): v is string => typeof v === 'string')
		: undefined
	return { name, type, required, values }
}

function normalizeSchema(raw: unknown): WorkspaceSchema | null {
	if (typeof raw !== 'object' || raw === null) return null
	const r = raw as Record<string, unknown>
	if (typeof r.workspace_id !== 'string') return null
	const typesRaw = r.types
	if (typeof typesRaw !== 'object' || typesRaw === null) return null
	const types: Record<string, TypeSchema> = {}
	for (const [typeName, typeRaw] of Object.entries(typesRaw as Record<string, unknown>)) {
		if (typeof typeRaw !== 'object' || typeRaw === null) continue
		const t = typeRaw as Record<string, unknown>
		const display_name = typeof t.display_name === 'string' ? t.display_name : typeName
		const statuses = Array.isArray(t.statuses)
			? t.statuses.filter((s): s is string => typeof s === 'string')
			: []
		const fields = Array.isArray(t.fields)
			? t.fields.map(normalizeField).filter((f): f is SchemaFieldDef => f !== null)
			: []
		types[typeName] = { display_name, statuses, fields }
	}
	return {
		workspace_id: r.workspace_id,
		workspace_name: typeof r.workspace_name === 'string' ? r.workspace_name : '',
		relationship_types: Array.isArray(r.relationship_types)
			? r.relationship_types.filter((rt): rt is string => typeof rt === 'string')
			: [],
		types,
	}
}

const SCHEMA_CACHE = new Map<string, WorkspaceSchema>()
const INFLIGHT = new Map<string, Promise<WorkspaceSchema>>()

export interface UseWorkspaceSchemaResult {
	schema: WorkspaceSchema | null
	loading: boolean
	error: string | null
	refresh: () => Promise<void>
}

/**
 * Fetches and caches the workspace schema returned by the `get_workspace_schema`
 * MCP tool. Cache is module-scope so multiple primitives mounted in the same
 * card don't refetch. Use `refresh()` to force a re-fetch when the schema is
 * known to be stale (e.g. after an extension toggle).
 */
export function useWorkspaceSchema(workspaceId?: string): UseWorkspaceSchemaResult {
	const callTool = useCallTool()
	const toolResult = useToolResult()
	const effectiveWsId = workspaceId ?? toolResult?.workspaceId ?? null
	const cacheKey = effectiveWsId ?? '__default__'

	const [schema, setSchema] = useState<WorkspaceSchema | null>(
		() => SCHEMA_CACHE.get(cacheKey) ?? null,
	)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const load = useCallback(
		async (force: boolean) => {
			if (!force) {
				const cached = SCHEMA_CACHE.get(cacheKey)
				if (cached) {
					setSchema(cached)
					return
				}
			}
			let inflight = !force ? INFLIGHT.get(cacheKey) : undefined
			if (!inflight) {
				const args: Record<string, unknown> = {}
				if (workspaceId) args.workspace_id = workspaceId
				inflight = (async () => {
					const result = await callTool('get_workspace_schema', args)
					const content = result.content as ToolContent[] | undefined
					const text = content?.find((c) => c.type === 'text')?.text
					if (!text) throw new Error('Empty schema response')
					const parsed = safeParseJson(text)
					const normalized = normalizeSchema(parsed)
					if (!normalized) throw new Error('Invalid schema shape')
					SCHEMA_CACHE.set(cacheKey, normalized)
					return normalized
				})()
				INFLIGHT.set(cacheKey, inflight)
			}
			setLoading(true)
			setError(null)
			try {
				const next = await inflight
				setSchema(next)
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err))
			} finally {
				INFLIGHT.delete(cacheKey)
				setLoading(false)
			}
		},
		[cacheKey, callTool, workspaceId],
	)

	useEffect(() => {
		if (!schema && !error) {
			void load(false)
		}
	}, [schema, error, load])

	const refresh = useCallback(async () => {
		SCHEMA_CACHE.delete(cacheKey)
		await load(true)
	}, [cacheKey, load])

	return { schema, loading, error, refresh }
}

/** Test-only: reset the module-level schema cache between specs. */
export function __resetSchemaCacheForTests() {
	SCHEMA_CACHE.clear()
	INFLIGHT.clear()
}
