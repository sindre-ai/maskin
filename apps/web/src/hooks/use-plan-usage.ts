import { useBillingUsage } from '@/hooks/use-billing'
import type { BillingUsageResponse } from '@/lib/api'
import { type PlanUsageState, planUsageState } from '@/lib/plan-usage'
import { useMemo } from 'react'

/** The percent state for a workspace, from the same billing read the stop uses. */
export function usePlanUsage(workspaceId: string): {
	state: PlanUsageState | null
	usage: BillingUsageResponse | undefined
	isPending: boolean
	isError: boolean
} {
	const { data, isPending, isError } = useBillingUsage(workspaceId)
	const state = useMemo(() => planUsageState(data), [data])
	return { state, usage: data, isPending, isError }
}
