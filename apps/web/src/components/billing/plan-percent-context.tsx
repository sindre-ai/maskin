import { createContext, useContext } from 'react'

/**
 * Whether the percent display and the 100% screens are on. The workspace layout
 * reads the `trial-card-percent` flag once and provides it here, so the sidebar
 * card, the billing page, the usage views and the chat route branch on one read
 * instead of each calling the flag hook.
 */
const PlanPercentContext = createContext(false)

export const PlanPercentProvider = PlanPercentContext.Provider

export function usePlanPercentEnabled(): boolean {
	return useContext(PlanPercentContext)
}
