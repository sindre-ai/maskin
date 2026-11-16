import { createContext, useContext } from 'react'

/**
 * Whether the percent display and the 100% screens are on. The workspace layout always
 * provides true, so the app runs the percent view everywhere. The default stays false only so
 * the older dollar-view component tests, which render without the layout, keep passing until
 * the dollar branches are deleted.
 */
const PlanPercentContext = createContext(false)

export const PlanPercentProvider = PlanPercentContext.Provider

export function usePlanPercentEnabled(): boolean {
	return useContext(PlanPercentContext)
}
