import Foundation
import Testing

@testable import MaskinCore

@Suite("Trial card step")
struct TrialCardStepTests {
	@Test("the card step is the web route for the workspace")
	func url() {
		#expect(TrialCardStep.url(workspaceId: "ws-1")?.absoluteString == "https://maskin.io/start-trial/ws-1")
	}

	@Test("only a workspace awaiting its card shows the notice")
	func awaitingCard() {
		var usage = BillingUsage(
			plan: "trial", status: .active, usedCents: 0, capCents: nil, creditBalanceCents: 0, resetsInMs: nil)
		#expect(!usage.awaitingCard)
		usage.trialState = .started
		#expect(!usage.awaitingCard)
		usage.trialState = .awaitingCard
		#expect(usage.awaitingCard)
	}
}
