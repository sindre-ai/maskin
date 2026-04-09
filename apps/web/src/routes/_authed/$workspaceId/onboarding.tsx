import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/onboarding')({
	component: OnboardingPage,
})

function OnboardingPage() {
	return <OnboardingWizard />
}
