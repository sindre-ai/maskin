import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("Activity filter")
struct ActivityFilterTests {
	private let comment = TimelineItem(id: "c", kind: .comment("Looks good, ship it."))
	private let update = TimelineItem(id: "u", kind: .activity("moved status to active"))

	@Test func allKeepsEverything() {
		#expect(ActivityFilter.all.apply(to: [comment, update]).map(\.id) == ["c", "u"])
	}

	@Test func commentsKeepsOnlyAuthoredText() {
		#expect(ActivityFilter.comments.apply(to: [comment, update]).map(\.id) == ["c"])
	}

	@Test func updatesKeepsOnlySystemEvents() {
		#expect(ActivityFilter.updates.apply(to: [comment, update]).map(\.id) == ["u"])
	}

	@Test func titlesAreOrderedAllCommentsUpdates() {
		#expect(ActivityFilter.allCases.map(\.title) == ["All", "Comments", "Updates"])
	}

	@Test func loadStateReadsFetchedFirst() {
		#expect(ActivityLoadState.of(fetched: true, revalidateFailed: true) == .ready)
		#expect(ActivityLoadState.of(fetched: false, revalidateFailed: true) == .failed)
		#expect(ActivityLoadState.of(fetched: false, revalidateFailed: false) == .loading)
	}
}
