import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("TV logic")
struct TVLogicTests {
	@Test func questionsGetYesNoChips() {
		#expect(TVQuickReplies.chips(lastMessage: "Send the quote to Northwind?") == ["Yes", "No", "Tell me more"])
	}

	@Test func statementsAndEmptyThreadsGetTheirOwnChips() {
		#expect(TVQuickReplies.chips(lastMessage: "Done.") == ["Thanks", "Got it", "Show me"])
		#expect(TVQuickReplies.chips(lastMessage: nil).count == 3)
	}

	@Test func understoodAsIsNilForAnEmptyQuery() {
		#expect(TVSearchGuide.understoodAs(query: "  ", sections: []) == nil)
	}

	@Test func understoodAsSaysWhenNothingMatches() {
		let line = TVSearchGuide.understoodAs(query: "zzz", sections: [])
		#expect(line?.contains("Nothing") == true)
	}

	@Test func profileRowsSplitIntoWorkspaceAndYou() {
		#expect(TVProfileRow.rows(in: .workspace).map(\.title) == ["Agents", "Marketplace", "Artefacts"])
		#expect(TVProfileRow.rows(in: .you).map(\.title) == ["Settings", "Autonomy"])
	}

	@Test func confirmCopyFallsBackWhenTheOptionHasNoConsequences() {
		let option = DecisionOption(label: "Send", consequences: [], recommended: false, destructive: true)
		#expect(TVConfirmCopy.message(for: option).contains("can't be undone"))
	}

	@Test func handoffLinkIsTheObjectDeepLink() {
		let handoff = TVHandoff(workspaceId: "w1", objectId: "o1", title: "Northwind")
		#expect(DeepLink(url: handoff.url) == .object(workspaceId: "w1", id: "o1"))
		#expect(handoff.makeActivity().isEligibleForHandoff)
	}

	@Test func deviceCodeSeamIsUnavailableUntilTheEndpointShips() async {
		await #expect(throws: TVDeviceCodeUnavailable.Unavailable.self) {
			_ = try await TVDeviceCodeUnavailable().start()
		}
	}
}

@Suite("TV decision age")
struct TVDecisionAgeTests {
	@Test func tagsOnlyOldDecisions() {
		let now = Date()
		#expect(TVDecisionAge.heldTag(since: now.addingTimeInterval(-3600), now: now) == nil)
		#expect(TVDecisionAge.heldTag(since: now.addingTimeInterval(-30 * 3600), now: now) == "held 1d")
		#expect(TVDecisionAge.heldTag(since: now.addingTimeInterval(-50 * 3600), now: now) == "held 2d")
	}
}

@Suite("TVCardOptions")
struct TVCardOptionsTests {
	@Test func recommendedLeadsAndRestCollapse() {
		let s = TVCardOptions.summary(labels: ["A", "B", "C"], recommended: "B")
		#expect(s.primary == "B" && s.more == 2)
	}
	@Test func fallsBackToFirst() {
		let s = TVCardOptions.summary(labels: ["A", "B"], recommended: nil)
		#expect(s.primary == "A" && s.more == 1)
		#expect(TVCardOptions.summary(labels: [], recommended: nil).more == 0)
	}
}
