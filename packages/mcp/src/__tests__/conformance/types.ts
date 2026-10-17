// Shared shapes for the MCP conformance matrix.
//
// The matrix is ONE table of rows (see rows.ts) run against ONE running app
// through five client styles. Everything here is plain data and interfaces so
// the same table can be driven by vitest (apps/dev integration config), by the
// standalone CLI against the built server (cli.ts), and by the docs generator
// (docs.ts).

export const CLIENT_STYLES = [
	'raw-legacy',
	'sdk-legacy',
	'sdk-auto',
	'sdk-modern',
	'raw-modern',
] as const

export type ClientStyle = (typeof CLIENT_STYLES)[number]

export type Era = 'legacy' | 'modern'

/** What a client style is, in the words the generated docs use. */
export const STYLE_LABELS: Record<ClientStyle, string> = {
	'raw-legacy': 'Raw legacy JSON-RPC (fixtures recorded from v1 main)',
	'sdk-legacy': 'SDK v2 Client, default (legacy) mode',
	'sdk-auto': 'SDK v2 Client, mode auto',
	'sdk-modern': 'SDK v2 Client, pinned to 2026-07-28',
	'raw-modern': 'Raw modern JSON-RPC, no SDK',
}

/**
 * Server capabilities a row can depend on. A row whose feature is not present
 * on the server under test reports "pending" instead of failing, so the
 * matrix can land before the pieces it covers (modern leg, cache hints). With
 * strict mode on (CI) pending is a failure, so a feature that never lands
 * cannot hide.
 */
export type Feature = 'sdk-client' | 'modern-leg' | 'cache-hints'

/** The server flag MASKIN_MCP_MODERN as the run was told it is set. */
export type FlagState = 'on' | 'off'

export interface Target {
	/** Origin of the running app, no trailing slash and no path. */
	baseUrl: string
	apiKey: string
	workspaceId: string
	/** The web app origin the server treats as allowed for the Origin check. */
	webAppOrigin: string
}

export interface RunEnv {
	flag: FlagState
	/** When set, the server under test was started with this response token cap. */
	responseCapTokens?: number
	/**
	 * File that carries the tools/list digest between two runs against two
	 * server processes. First run writes it, a later run compares. This is how
	 * "byte-identical across restarts" is proven against a built server.
	 */
	digestFile?: string
	strict: boolean
}

export interface Observed {
	status: number
	contentType: string | null
	headers: Record<string, string>
	text: string
	json: unknown
}

export interface ToolDef {
	name: string
	description?: string
}

export interface ToolOutcome {
	isError: boolean
	/** JSON-RPC error code when the failure came back as a protocol error. */
	errorCode?: number
	text: string
	structured?: unknown
	/** The result's _meta, where the response cap reports truncation. */
	meta?: Record<string, unknown>
}

export interface ResourceDef {
	uri: string
	mimeType?: string
}

export interface TemplateDef {
	name: string
	uriTemplate: string
}

export interface ResourceContent {
	uri: string
	mimeType?: string
	text?: string
}

export interface ConnectInfo {
	era: Era
	protocolVersion: string | undefined
}

/** The operations every client style can perform, so rows are written once. */
export interface Driver {
	readonly style: ClientStyle
	connect(): Promise<ConnectInfo>
	listTools(): Promise<ToolDef[]>
	callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome>
	listResources(): Promise<ResourceDef[]>
	listResourceTemplates(): Promise<TemplateDef[]>
	readResource(uri: string): Promise<ResourceContent[]>
	close(): Promise<void>
}

export interface DriverOptions {
	/** Send no Authorization header. */
	noAuth?: boolean
}

export interface RowContext {
	style: ClientStyle
	target: Target
	env: RunEnv
	features: ReadonlySet<Feature>
	/** A connected driver for this row's own style. */
	driver(options?: DriverOptions): Promise<Driver>
	/** A connected driver for another style, for cross-era comparisons. */
	driverFor(style: ClientStyle, options?: DriverOptions): Promise<Driver>
}

export interface Row {
	/** Stable id. Docs and CI output are keyed on it. */
	id: string
	area: string
	title: string
	/** One plain sentence: what a pass of this row guarantees. Goes into the docs. */
	proves: string
	styles: readonly ClientStyle[]
	needs?: readonly Feature[]
	/** Only meaningful when the server runs with this flag state. */
	flag?: FlagState
	/** Only meaningful when the server was started with a lowered response cap. */
	needsResponseCap?: true
	run(ctx: RowContext): Promise<void>
}

export type RowStatus = 'pass' | 'fail' | 'pending' | 'n/a'

export interface RowResult {
	rowId: string
	style: ClientStyle
	status: RowStatus
	detail?: string
}
