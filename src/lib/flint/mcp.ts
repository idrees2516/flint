// ─────────────────────────────────────────────────────────────
// Flint · MCP Client — Model Context Protocol over HTTP
// (JSON-RPC 2.0) with tool policies, caching and a service
// catalog. stdio servers are executed inside sandboxes.
// ─────────────────────────────────────────────────────────────
import { db } from '@/lib/db'
import { retryAsync } from './concurrency'

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>
}

/** Well-known MCP service catalog (connectable services). */
export const MCP_CATALOG = [
  { name: 'notion', label: 'Notion', category: 'docs', url: 'https://mcp.notion.com/mcp', desc: 'Search, read and update Notion pages and databases.' },
  { name: 'linear', label: 'Linear', category: 'issues', url: 'https://mcp.linear.app/sse', desc: 'Query and manage Linear issues, projects and cycles.' },
  { name: 'slack', label: 'Slack', category: 'chat', url: 'https://mcp.slack.com/sse', desc: 'Send messages, read channels, manage threads.' },
  { name: 'serper', label: 'Serper Websearch', category: 'search', url: 'https://flint-mcp.serper.dev/mcp', desc: 'Google search with knowledge graph results.' },
  { name: 'github', label: 'GitHub', category: 'dev', url: 'https://api.githubcopilot.com/mcp/', desc: 'Repos, issues, PRs, code search.' },
  { name: 'postgres', label: 'Postgres', category: 'data', url: '', command: 'npx -y @modelcontextprotocol/server-postgres', desc: 'Query a Postgres database (stdio).' },
  { name: 'filesystem', label: 'Filesystem', category: 'dev', url: '', command: 'npx -y @modelcontextprotocol/server-filesystem', desc: 'Bounded filesystem access (stdio).' },
  { name: 'puppeteer', label: 'Puppeteer', category: 'browser', url: '', command: 'npx -y @modelcontextprotocol/server-puppeteer', desc: 'Drive a headless browser (stdio).' },
]

// ── JSON-RPC over HTTP ──────────────────────────────────────
let rpcSeq = 0

async function rpc(url: string, method: string, params?: Record<string, unknown>, headers: Record<string, string> = {}, timeoutMs = 20000): Promise<unknown> {
  const id = ++rpcSeq
  const res = await retryAsync(
    () =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }),
        signal: AbortSignal.timeout(timeoutMs),
      }),
    { retries: 1, baseMs: 300 }
  )
  if (!res.ok) throw new Error(`MCP ${method} → HTTP ${res.status}`)
  const ct = res.headers.get('content-type') ?? ''
  let payload: Record<string, unknown>
  if (ct.includes('text/event-stream')) {
    // SSE transport — find the first data: line with our id
    const text = await res.text()
    const dataLine = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .find((o) => o && (o as Record<string, unknown>).id === id)
    if (!dataLine) throw new Error(`MCP ${method} → no SSE response for id ${id}`)
    payload = dataLine as Record<string, unknown>
  } else {
    payload = (await res.json()) as Record<string, unknown>
  }
  if (payload.error) throw new Error(`MCP ${method} error: ${JSON.stringify(payload.error).slice(0, 300)}`)
  return payload.result
}

function authHeaders(server: { headers: string; bearerTokenEnvVar: string }): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const h = JSON.parse(server.headers || '{}') as Record<string, string>
    for (const [k, v] of Object.entries(h)) out[k] = v
  } catch {
    /* ignore bad header json */
  }
  if (server.bearerTokenEnvVar && process.env[server.bearerTokenEnvVar]) {
    out.authorization = `Bearer ${process.env[server.bearerTokenEnvVar]}`
  }
  return out
}

function applyPolicy(
  tools: McpToolInfo[],
  server: { enabledTools: string; disabledTools: string }
): McpToolInfo[] {
  let enabled: string[] = []
  let disabled: string[] = []
  try {
    enabled = JSON.parse(server.enabledTools || '[]')
    disabled = JSON.parse(server.disabledTools || '[]')
  } catch {
    /* ignore bad policy json */
  }
  return tools.filter((t) => (enabled.length === 0 || enabled.includes(t.name)) && !disabled.includes(t.name))
}

// ── server registry ops ─────────────────────────────────────
export async function upsertMcpServer(entry: {
  name: string
  transport?: string
  url?: string
  command?: string
  args?: string[]
  headers?: Record<string, string>
  bearerTokenEnvVar?: string
  enabled?: boolean
  enabledTools?: string[]
  disabledTools?: string[]
}) {
  const existing = await db.mcpServer.findUnique({ where: { name: entry.name } })
  const data = {
    name: entry.name,
    transport: entry.transport === 'stdio' ? 'stdio' : 'http',
    url: entry.url ?? '',
    command: entry.command ?? '',
    args: JSON.stringify(entry.args ?? []),
    headers: JSON.stringify(entry.headers ?? {}),
    bearerTokenEnvVar: entry.bearerTokenEnvVar ?? '',
    enabled: entry.enabled ?? true,
    enabledTools: JSON.stringify(entry.enabledTools ?? []),
    disabledTools: JSON.stringify(entry.disabledTools ?? []),
  }
  if (existing) return db.mcpServer.update({ where: { id: existing.id }, data })
  return db.mcpServer.create({ data })
}

export async function listMcpServers() {
  return db.mcpServer.findMany({ orderBy: { createdAt: 'asc' } })
}

export async function deleteMcpServer(id: string) {
  await db.mcpServer.delete({ where: { id } }).catch(() => null)
}

/** List tools for a server (HTTP only; stdio documented as sandbox-executed). */
export async function listTools(serverName: string): Promise<McpToolInfo[]> {
  const server = await db.mcpServer.findUnique({ where: { name: serverName } })
  if (!server) throw new Error(`unknown MCP server "${serverName}"`)
  if (!server.enabled) return []
  if (server.transport === 'stdio') {
    // stdio servers run inside sandboxes — surface the command contract
    return [
      {
        name: 'run_in_sandbox',
        description: `stdio MCP server "${server.name}" — launch with: ${server.command} ${server.args} (executed in sandbox; JSON-RPC over stdio)`,
      },
    ]
  }
  if (!server.url) return []
  const hdrs = authHeaders(server)
  await rpc(server.url, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'flint', version: '1.0.0' },
  }, hdrs, 15000).catch(() => null) // best-effort handshake
  const result = (await rpc(server.url, 'tools/list', {}, hdrs)) as { tools?: McpToolInfo[] }
  const tools = applyPolicy(result.tools ?? [], server)
  await db.mcpServer.update({
    where: { id: server.id },
    data: { toolCount: tools.length, lastListAt: new Date() },
  }).catch(() => null)
  return tools
}

export async function callTool(serverName: string, tool: string, args: Record<string, unknown> = {}): Promise<string> {
  const server = await db.mcpServer.findUnique({ where: { name: serverName } })
  if (!server) throw new Error(`unknown MCP server "${serverName}"`)
  if (server.transport === 'stdio') throw new Error('stdio MCP servers must be launched inside a sandbox (see run_in_sandbox)')
  if (!server.url) throw new Error('server has no URL')
  const policy = applyPolicy([{ name: tool }], server)
  if (policy.length === 0) throw new Error(`tool "${tool}" is disabled by policy on "${serverName}"`)
  const hdrs = authHeaders(server)
  const result = (await rpc(server.url, 'tools/call', { name: tool, arguments: args }, hdrs, 60000)) as McpCallResult
  const text = (result.content ?? [])
    .map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c)))
    .join('\n')
  return text.slice(0, 8000) || JSON.stringify(result).slice(0, 2000)
}

/** Aggregate view for the system prompt + UI. */
export async function mcpOverview(): Promise<Array<{ name: string; enabled: boolean; transport: string; toolCount: number }>> {
  const servers = await listMcpServers()
  return servers.map((s) => ({ name: s.name, enabled: s.enabled, transport: s.transport, toolCount: s.toolCount }))
}
