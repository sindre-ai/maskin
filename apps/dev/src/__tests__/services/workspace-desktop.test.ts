import { describe, expect, it, vi } from 'vitest'
import { type DesktopServer, WorkspaceDesktopService } from '../../services/workspace-desktop'

const WS = '11111111-1111-4111-8111-111111111111'

const server = (id: string, status: DesktopServer['status'] = 'active'): DesktopServer => ({
	id,
	url: `https://${id}.example`,
	secret: `secret-${id}`,
	status,
})

function res(status: number, body: unknown = {}): Response {
	return new Response(JSON.stringify(body), { status })
}

describe('WorkspaceDesktopService', () => {
	it('locate returns the server that already hosts the desktop', async () => {
		const fetchImpl = vi.fn(async (url: string | URL | Request) =>
			String(url).includes('b.example') ? res(200, { password: 'pw' }) : res(404),
		) as unknown as typeof fetch
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('a'), server('b')],
			fetchImpl,
		})

		const found = await svc.locate(WS)

		expect(found?.server.id).toBe('b')
		expect(found?.password).toBe('pw')
	})

	it('locate sends the bearer secret and skips disabled servers', async () => {
		const fetchImpl = vi.fn(async () => res(404))
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('a'), server('x', 'disabled')],
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})

		await svc.locate(WS)

		expect(fetchImpl).toHaveBeenCalledTimes(1)
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe(`https://a.example/desktops/${WS}`)
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-a')
	})

	it('locate tolerates a server that errors', async () => {
		const fetchImpl = vi.fn(async (url: string | URL | Request) => {
			if (String(url).includes('a.example')) throw new Error('down')
			return res(200, { password: 'pw' })
		}) as unknown as typeof fetch
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('a'), server('b')],
			fetchImpl,
		})
		expect((await svc.locate(WS))?.server.id).toBe('b')
	})

	it('ensure reuses an existing desktop without provisioning', async () => {
		const fetchImpl = vi.fn(async () => res(200, { password: 'pw' }))
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('a')],
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})

		const got = await svc.ensure(WS)

		expect(got?.created).toBeUndefined()
		for (const call of fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>) {
			expect(call[1].method).toBe('GET')
		}
	})

	it('ensure provisions on the first active server when none hosts it', async () => {
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
			init?.method === 'PUT' ? res(200, { password: 'new' }) : res(404),
		) as unknown as typeof fetch
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('d', 'draining'), server('a'), server('b')],
			fetchImpl,
		})

		const got = await svc.ensure(WS)

		expect(got).toMatchObject({ password: 'new', created: true })
		expect(got?.server.id).toBe('a')
	})

	it('ensure returns null with no active server or when provisioning fails', async () => {
		const none = new WorkspaceDesktopService({
			listServers: async () => [server('d', 'draining')],
			fetchImpl: (async () => res(404)) as unknown as typeof fetch,
		})
		expect(await none.ensure(WS)).toBeNull()

		const failing = new WorkspaceDesktopService({
			listServers: async () => [server('a')],
			fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) =>
				init?.method === 'PUT' ? res(502) : res(404)) as unknown as typeof fetch,
		})
		expect(await failing.ensure(WS)).toBeNull()
	})

	it('remove deletes on the hosting server and reports whether one existed', async () => {
		const calls: string[] = []
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push(`${init?.method} ${String(url)}`)
			if (init?.method === 'GET') return res(200, { password: 'pw' })
			return res(200, { removed: true })
		}) as unknown as typeof fetch
		const svc = new WorkspaceDesktopService({ listServers: async () => [server('a')], fetchImpl })

		expect(await svc.remove(WS)).toBe(true)
		expect(calls).toContain(`DELETE https://a.example/desktops/${WS}`)

		const empty = new WorkspaceDesktopService({
			listServers: async () => [server('a')],
			fetchImpl: (async () => res(404)) as unknown as typeof fetch,
		})
		expect(await empty.remove(WS)).toBe(false)
	})
})
