import type React from 'react'

export function mockTanStackRouter() {
	return {
		Link: ({
			children,
			...rest
		}: { children: React.ReactNode; to?: string; params?: Record<string, string> }) => (
			<a href={rest.to} {...rest}>
				{children}
			</a>
		),
		useNavigate: () => vi.fn(),
	}
}
