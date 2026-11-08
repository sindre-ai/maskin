import MaskinCore
import Testing

@testable import MaskinFeatures

@MainActor
@Suite("For you draft pointer")
struct DraftPointerTests {
	private func draft(_ objectId: String?) -> DecisionDraft {
		DecisionDraft(label: "Email to Peter", body: "Hej Peter", objectId: objectId)
	}

	private func prompt(draft: DecisionDraft? = nil, drafts: [DecisionDraft] = []) -> DecisionPrompt {
		DecisionPrompt(
			title: "Reply to Peter", summary: "Ready.", ask: "Send?",
			options: [DecisionOption(label: "Send as written", recommended: true)],
			draft: draft, drafts: drafts)
	}

	@Test func pointsAtTheDraftThatIsUnderDraftsToReview() {
		let found = DecisionCardView.firstDraftElsewhere(
			in: prompt(draft: draft("obj-1")), isElsewhere: { _ in true })
		#expect(found?.objectId == "obj-1")
	}

	@Test func skipsADraftThatIsShownOnTheCard() {
		let found = DecisionCardView.firstDraftElsewhere(
			in: prompt(drafts: [draft("shown"), draft("elsewhere")]),
			isElsewhere: { $0.objectId == "elsewhere" })
		#expect(found?.objectId == "elsewhere")
	}

	@Test func nothingToPointAtWhenEveryDraftIsOnTheCard() {
		let found = DecisionCardView.firstDraftElsewhere(
			in: prompt(draft: draft("obj-1")), isElsewhere: { _ in false })
		#expect(found == nil)
		#expect(DecisionCardView.firstDraftElsewhere(in: nil, isElsewhere: { _ in true }) == nil)
	}

	@Test func eachDraftHasItsOwnScrollId() {
		#expect(ForYouFeedView.draftRowId("obj-1") != ForYouFeedView.draftRowId("obj-2"))
		#expect(ForYouFeedView.draftRowId("obj-1") == ForYouFeedView.draftRowId("obj-1"))
	}
}
