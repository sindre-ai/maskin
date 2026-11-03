import Foundation
import Testing

@testable import MaskinCore

@Suite("ObjectsQuickFilter")
struct ObjectsQuickFilterTests {
	private let now = Date(timeIntervalSince1970: 1_800_000_000)

	private func object(created: Date? = nil, starred: Bool = false, working: Bool = false) -> WorkObject {
		WorkObject(
			id: "o", type: "task", title: "T", status: "open", createdAt: created, isStarred: starred,
			hasActiveSession: working)
	}

	@Test func starredMatchesStarredRows() {
		#expect(ObjectsQuickFilter.starred.matches(object(starred: true), now: now))
		#expect(!ObjectsQuickFilter.starred.matches(object(), now: now))
	}

	@Test func newLastSevenDaysUsesTheCreationDate() {
		let recent = now.addingTimeInterval(-3 * 86_400)
		let old = now.addingTimeInterval(-9 * 86_400)
		#expect(ObjectsQuickFilter.newThisWeek.matches(object(created: recent), now: now))
		#expect(!ObjectsQuickFilter.newThisWeek.matches(object(created: old), now: now))
		#expect(!ObjectsQuickFilter.newThisWeek.matches(object(), now: now))
	}

	@Test func workingFollowsTheActiveSession() {
		#expect(ObjectsQuickFilter.working.matches(object(working: true), now: now))
		#expect(!ObjectsQuickFilter.working.matches(object(), now: now))
	}
}
