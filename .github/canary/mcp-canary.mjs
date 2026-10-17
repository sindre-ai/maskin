// Hourly modern-path canary for the Maskin MCP server (bet: MCP 2026-07-28 / SDK v2).
// Connects with the v2 client pinned to 2026-07-28 (no fallback to legacy), checks the
// negotiated era, then makes one list_tools and one list_workspaces call. Exits 1 on any
// failure so the Actions run goes red. Read-only calls only.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const PIN = '2026-07-28'
const url = process.env.MCP_URL || 'https://maskin.io/mcp'
const apiKey = process.env.MASKIN_PROBE_API_KEY
const workspaceId = process.env.MASKIN_PROBE_WORKSPACE_ID

const fail = (stage, err) => {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  console.error(`::error title=canary failed at ${stage}::${msg}`)
  process.exitCode = 1
}

if (!apiKey || !workspaceId) {
  fail('config', 'MASKIN_PROBE_API_KEY or MASKIN_PROBE_WORKSPACE_ID is not set')
  process.exit(1)
}

const client = new Client(
  { name: 'maskin-probe', version: '1' },
  { versionNegotiation: { mode: { pin: PIN } } },
)
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'X-Workspace-Id': workspaceId,
      'User-Agent': 'maskin-probe/1',
    },
  },
})

let stage = 'connect'
try {
  await client.connect(transport)
  stage = 'era'
  const era = client.getProtocolEra()
  const version = client.getNegotiatedProtocolVersion()
  if (era !== 'modern' || version !== PIN) {
    throw new Error(`expected modern/${PIN}, got ${era}/${version}`)
  }
  stage = 'list_tools'
  const { tools } = await client.listTools()
  if (!tools?.length) throw new Error('tools/list returned no tools')
  stage = 'list_workspaces'
  const res = await client.callTool({ name: 'list_workspaces', arguments: {} })
  if (res.isError) throw new Error(`list_workspaces returned isError: ${JSON.stringify(res.content).slice(0, 300)}`)
  console.log(`ok era=${era} version=${version} tools=${tools.length}`)
} catch (err) {
  fail(stage, err)
} finally {
  await client.close().catch(() => {})
}
