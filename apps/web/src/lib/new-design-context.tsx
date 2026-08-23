import { createContext, useContext } from 'react'

/**
 * Carries the `new-design` flag from its single boundary
 * (`routes/_authed/$workspaceId.tsx`) down to the handful of v2 components that
 * are rendered by *route pages* rather than by the shell, and so cannot be
 * swapped at the boundary itself.
 *
 * This is deliberately NOT a second `useFeatureFlag('new-design')` call site —
 * the flag is still read exactly once, at the boundary, and only the resolved
 * boolean travels. Read it with `useNewDesign()`.
 *
 * Defaults to `false` so anything rendered outside the workspace shell (and
 * every test that does not opt in) gets the pre-v2 branch.
 *
 * This context dies with the `new-design` flag — see
 * `.claude/rules/feature-flags.md`, "Retiring a flag".
 */
const NewDesignContext = createContext(false)

export function NewDesignProvider({
	value,
	children,
}: {
	value: boolean
	children: React.ReactNode
}) {
	return <NewDesignContext.Provider value={value}>{children}</NewDesignContext.Provider>
}

export function useNewDesign(): boolean {
	return useContext(NewDesignContext)
}
