import { ApiError } from '@/lib/api'
import type { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

type Navigate = ReturnType<typeof useNavigate>

function showPlanLimitToast(navigate: Navigate, workspaceId: string, isTrial: boolean): void {
	toast.error(
		isTrial
			? 'Trial limit reached — upgrade to keep going'
			: 'Plan limit reached — buy usage credits or upgrade to keep going',
		{
			action: {
				label: 'Go to Billing',
				onClick: () => navigate({ to: '/$workspaceId/settings/keys', params: { workspaceId } }),
			},
		},
	)
}

/**
 * Toasts a clear, actionable message when starting or restarting a session
 * fails because the workspace is over its Maskin-plan token cap (trial
 * limit, or a paid plan with no usage credits left) — without this, the
 * mutation just fails silently and the user has no idea why nothing
 * happened. Falls back to a generic error toast for anything else.
 */
export function toastSessionCreateError(
	err: unknown,
	navigate: Navigate,
	workspaceId: string,
): void {
	if (err instanceof ApiError && err.code === 'PLAN_CAP_EXCEEDED') {
		showPlanLimitToast(navigate, workspaceId, err.planCapContext?.plan === 'trial')
		return
	}
	toast.error(err instanceof Error ? err.message : 'Failed to start session')
}

/**
 * Same toast as toastSessionCreateError's plan-cap branch, for a session that
 * was killed mid-run by SessionManager's budget watchdog instead of being
 * blocked at start — without this, an interactive chat session just goes
 * quiet with no explanation. enforceRunningSessionBudget only ever stops
 * pro/team sessions (trial sessions never reach it), so this is always the
 * paid-plan copy.
 */
export function toastSessionBudgetStopped(navigate: Navigate, workspaceId: string): void {
	showPlanLimitToast(navigate, workspaceId, false)
}
