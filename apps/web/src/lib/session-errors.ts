import { ApiError } from '@/lib/api'
import { isViewerRefusal } from '@/lib/workspace-role'
import type { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

type Navigate = ReturnType<typeof useNavigate>

function showPlanLimitToast(navigate: Navigate, workspaceId: string, isTrial: boolean): void {
	toast.error(
		isTrial
			? 'Trial limit reached — upgrade to keep going'
			: 'Plan limit reached — change plan to keep going',
		{
			action: {
				label: 'Go to Billing',
				onClick: () => navigate({ to: '/$workspaceId/settings/billing', params: { workspaceId } }),
			},
		},
	)
}

/**
 * Toasts a clear, actionable message when starting or restarting a session
 * fails because the workspace has used 100% of its Maskin plan (trial
 * limit, or a paid plan with no usage credits left) — without this, the
 * mutation just fails silently and the user has no idea why nothing
 * happened. Falls back to a generic error toast for anything else.
 */
export function toastSessionCreateError(
	err: unknown,
	navigate: Navigate,
	workspaceId: string,
	fallbackMessage?: string,
): void {
	if (err instanceof ApiError && err.code === 'PLAN_CAP_EXCEEDED') {
		showPlanLimitToast(navigate, workspaceId, err.planCapContext?.plan === 'trial')
		return
	}
	// The workspace is waiting for its card: nothing runs until the trial has started.
	if (err instanceof ApiError && err.code === 'TRIAL_NOT_STARTED') {
		toast.error('Your trial has not started. Add a card to begin your 7 days.', {
			action: {
				label: 'Add card',
				onClick: () => navigate({ to: '/start-trial/$workspaceId', params: { workspaceId } }),
			},
		})
		return
	}
	// A viewer's refused start already got the shared message from the global handler.
	if (isViewerRefusal(err)) return
	// `fallbackMessage` lets a call site keep its own more specific copy for
	// non-billing failures (e.g. the agents grid, where the card knows which
	// agent failed) without having to re-test for PLAN_CAP_EXCEEDED itself.
	if (fallbackMessage) {
		toast.error(fallbackMessage)
		return
	}
	toast.error(err instanceof Error ? err.message : 'Failed to start session')
}

/**
 * Same toast as toastSessionCreateError's plan-cap branch, for a session that
 * was killed mid-run by SessionManager's budget watchdog instead of being
 * blocked at start — without this, an interactive chat session just goes
 * quiet with no explanation. enforceRunningSessionBudget stops a session on any
 * plan at 100%, trial included, so the copy follows the plan the workspace is on.
 */
export function toastSessionBudgetStopped(
	navigate: Navigate,
	workspaceId: string,
	isTrial = false,
): void {
	showPlanLimitToast(navigate, workspaceId, isTrial)
}
