// One Driver per client style. Rows call the Driver interface so a row is
// written once and runs for every style it applies to.

import type {
	ClientStyle,
	ConnectInfo,
	Driver,
	DriverOptions,
	Era,
	Observed,
	ResourceContent,
	ResourceDef,
	Target,
	TemplateDef,
	ToolDef,
	ToolOutcome,
} from './types'
import {
	MODERN_VERSION,
	endpoint,
	legacyInitialize,
	legacyRequest,
	post,
	postModern,
	rpc,
	rpcResult,
} from './wire'

interface TextContent {
	type?: string
	text?: string
}

function outcomeFromResult(result: Record<string, unknown>): ToolOutcome {
	const content = (result.content as TextContent[] | undefined) ?? []
	return {
		isError: result.isError === true,
		text: content
			.filter((c) => c.type === 'text')
			.map((c) => c.text ?? '')
			.join('\n'),
		structured: result.structuredContent,
		meta: result._meta as Record<string, unknown> | undefined,
	}
}

// ── Raw styles ──────────────────────────────────────────────────────────────

class RawDriver implements Driver {
	constructor(
		readonly style: 'raw-legacy' | 'raw-modern',
		private readonly target: Target,
		private readonly options: DriverOptions,
	) {}

	private get era(): Era {
		return this.style === 'raw-modern' ? 'modern' : 'legacy'
	}

	private send(method: string, params?: Record<string, unknown>): Promise<Observed> {
		const sendOptions = { noAuth: this.options.noAuth }
		return this.era === 'modern'
			? postModern(this.target, method, params ?? {}, sendOptions)
			: post(this.target, legacyRequest(method, params), sendOptions)
	}

	private async result(method: string, params?: Record<string, unknown>) {
		return rpcResult(await this.send(method, params))
	}

	async connect(): Promise<ConnectInfo> {
		if (this.era === 'modern') {
			const result = await this.result('server/discover')
			const versions = (result.supportedVersions as string[] | undefined) ?? []
			return {
				era: 'modern',
				protocolVersion: versions.includes(MODERN_VERSION) ? MODERN_VERSION : versions[0],
			}
		}
		const result = rpcResult(
			await post(this.target, legacyInitialize(), { noAuth: this.options.noAuth }),
		)
		await post(
			this.target,
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			{ noAuth: this.options.noAuth },
		)
		return { era: 'legacy', protocolVersion: result.protocolVersion as string | undefined }
	}

	async listTools(): Promise<ToolDef[]> {
		return (await this.result('tools/list')).tools as ToolDef[]
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
		const body = rpc(await this.send('tools/call', { name, arguments: args }))
		if (body.error) {
			return { isError: true, errorCode: body.error.code, text: body.error.message }
		}
		return outcomeFromResult(body.result ?? {})
	}

	async listResources(): Promise<ResourceDef[]> {
		return (await this.result('resources/list')).resources as ResourceDef[]
	}

	async listResourceTemplates(): Promise<TemplateDef[]> {
		return (await this.result('resources/templates/list')).resourceTemplates as TemplateDef[]
	}

	async readResource(uri: string): Promise<ResourceContent[]> {
		return (await this.result('resources/read', { uri })).contents as ResourceContent[]
	}

	async close(): Promise<void> {}
}

// ── SDK styles ──────────────────────────────────────────────────────────────

// Just the surface of the v2 Client this suite touches. The package is loaded
// with a dynamic import so a checkout without it fails one feature probe, not
// the whole file.
interface SdkClientLike {
	connect(transport: unknown): Promise<void>
	close(): Promise<void>
	getProtocolEra(): Era | undefined
	getNegotiatedProtocolVersion(): string | undefined
	listTools(): Promise<{ tools: ToolDef[] }>
	callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<
		Record<string, unknown>
	>
	listResources(): Promise<{ resources: ResourceDef[] }>
	listResourceTemplates(): Promise<{ resourceTemplates: TemplateDef[] }>
	readResource(params: { uri: string }): Promise<{ contents: ResourceContent[] }>
}

interface SdkModule {
	Client: new (info: { name: string; version: string }, options?: unknown) => SdkClientLike
	StreamableHTTPClientTransport: new (url: URL, options?: unknown) => unknown
}

export async function loadSdkClient(): Promise<SdkModule> {
	return (await import('@modelcontextprotocol/client')) as unknown as SdkModule
}

const NEGOTIATION: Record<'sdk-legacy' | 'sdk-auto' | 'sdk-modern', unknown> = {
	'sdk-legacy': undefined,
	'sdk-auto': { mode: 'auto' },
	'sdk-modern': { mode: { pin: MODERN_VERSION } },
}

class SdkDriver implements Driver {
	private client: SdkClientLike | undefined

	constructor(
		readonly style: 'sdk-legacy' | 'sdk-auto' | 'sdk-modern',
		private readonly target: Target,
		private readonly options: DriverOptions,
	) {}

	private get connected(): SdkClientLike {
		if (!this.client) throw new Error('driver used before connect()')
		return this.client
	}

	async connect(): Promise<ConnectInfo> {
		const sdk = await loadSdkClient()
		const negotiation = NEGOTIATION[this.style]
		const client = new sdk.Client(
			{ name: 'maskin-conformance', version: '1' },
			negotiation ? { versionNegotiation: negotiation } : {},
		)
		const headers: Record<string, string> = { 'X-Workspace-Id': this.target.workspaceId }
		if (!this.options.noAuth) headers.Authorization = `Bearer ${this.target.apiKey}`
		const transport = new sdk.StreamableHTTPClientTransport(new URL(endpoint(this.target)), {
			requestInit: { headers },
		})
		await client.connect(transport)
		this.client = client
		const era = client.getProtocolEra()
		if (!era) throw new Error('SDK client connected but reports no protocol era')
		return { era, protocolVersion: client.getNegotiatedProtocolVersion() }
	}

	async listTools(): Promise<ToolDef[]> {
		return (await this.connected.listTools()).tools
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
		try {
			return outcomeFromResult(await this.connected.callTool({ name, arguments: args }))
		} catch (err) {
			// A JSON-RPC error response surfaces as a thrown protocol error that
			// carries the numeric code. Anything else is a real failure.
			const code = (err as { code?: unknown }).code
			if (typeof code === 'number') {
				return { isError: true, errorCode: code, text: (err as Error).message }
			}
			throw err
		}
	}

	async listResources(): Promise<ResourceDef[]> {
		return (await this.connected.listResources()).resources
	}

	async listResourceTemplates(): Promise<TemplateDef[]> {
		return (await this.connected.listResourceTemplates()).resourceTemplates
	}

	async readResource(uri: string): Promise<ResourceContent[]> {
		return (await this.connected.readResource({ uri })).contents
	}

	async close(): Promise<void> {
		await this.client?.close()
	}
}

export function createDriver(
	style: ClientStyle,
	target: Target,
	options: DriverOptions = {},
): Driver {
	if (style === 'raw-legacy' || style === 'raw-modern') {
		return new RawDriver(style, target, options)
	}
	return new SdkDriver(style, target, options)
}
