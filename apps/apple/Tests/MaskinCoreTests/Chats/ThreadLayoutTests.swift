import Foundation
import Testing

@testable import MaskinCore

@Suite("ThreadLayout runs and emoji") struct ThreadLayoutRunTests {
	private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

	private func message(_ id: Int, _ actor: String, _ text: String = "hi", at offset: TimeInterval) -> ChatMessage {
		.confirmed(
			serverID: id, conversationID: "c", actorID: actor, actorName: actor, author: .human,
			content: text, createdAt: t0.addingTimeInterval(offset))
	}

	@Test func aRunKnowsItsPreviousMessageAndWhereItEnds() {
		let items = ThreadLayout.items(for: [
			message(1, "a", at: 0), message(2, "a", at: 30), message(3, "a", at: 60), message(4, "b", at: 90),
		])
		let runs = ThreadLayout.runs(in: items)
		#expect(runs["m1"] == .init(previousID: nil, endsRun: false))
		#expect(runs["m2"] == .init(previousID: "m1", endsRun: false))
		#expect(runs["m3"] == .init(previousID: "m2", endsRun: true))
		#expect(runs["m4"] == .init(previousID: nil, endsRun: true))
	}

	@Test func aLongPauseBreaksTheRun() {
		let items = ThreadLayout.items(for: [message(1, "a", at: 0), message(2, "a", at: ThreadLayout.runGap + 1)])
		let runs = ThreadLayout.runs(in: items)
		#expect(runs["m1"]?.endsRun == true)
		#expect(runs["m2"]?.previousID == nil)
	}

	@Test func aNewDayBreaksTheRun() {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = TimeZone(identifier: "UTC")!
		let items = ThreadLayout.items(
			for: [message(1, "a", at: 0), message(2, "a", at: 24 * 3600)], calendar: calendar)
		let runs = ThreadLayout.runs(in: items)
		#expect(runs["m1"]?.endsRun == true)
		#expect(runs["m2"]?.previousID == nil)
	}

	@Test(arguments: ["👍", "🎉🎉", "🇳🇴", "👨‍👩‍👧", " 😂 "])
	func emojiOnly(text: String) {
		#expect(message(1, "a", text, at: 0).isEmojiOnly)
	}

	@Test(arguments: ["", "ok", "👍 ok", "1", "#", "© 2026", "👍👍👍👍", "a👍"])
	func notEmojiOnly(text: String) {
		#expect(!message(1, "a", text, at: 0).isEmojiOnly)
	}
	// MARK: Unread divider

	private func divider(_ items: [ThreadItem]) -> Int? {
		items.firstIndex { if case .unreadDivider = $0 { true } else { false } }
	}

	@Test func theDividerSitsBeforeTheFirstUnreadMessageFromSomeoneElse() {
		let items = ThreadLayout.items(
			for: [message(1, "a", at: 0), message(2, "me", at: 10), message(3, "a", at: 20), message(4, "a", at: 30)],
			unreadAfter: 2, currentActorID: "me")
		let at = try! #require(divider(items))
		if case .message(let next, let showsAuthor) = items[at + 1] {
			#expect(next.serverID == 3)
			#expect(showsAuthor)
		} else {
			Issue.record("expected the unread message after the divider")
		}
		if case .unreadDivider(let count) = items[at] { #expect(count == 2) }
	}

	@Test func yourOwnNewerMessagesAreNotUnread() {
		let items = ThreadLayout.items(
			for: [message(1, "a", at: 0), message(2, "me", at: 10)], unreadAfter: 1, currentActorID: "me")
		#expect(divider(items) == nil)
	}

	@Test func noCursorOrNothingNewMeansNoDivider() {
		let rows = [message(1, "a", at: 0), message(2, "a", at: 10)]
		#expect(divider(ThreadLayout.items(for: rows, unreadAfter: nil, currentActorID: "me")) == nil)
		#expect(divider(ThreadLayout.items(for: rows, unreadAfter: 2, currentActorID: "me")) == nil)
	}

	@Test func theDividerBreaksTheAuthorRunSoTheHeaderShowsAgain() {
		let items = ThreadLayout.items(
			for: [message(1, "a", at: 0), message(2, "a", at: 10)], unreadAfter: 1, currentActorID: "me")
		let runs = ThreadLayout.runs(in: items)
		#expect(runs["m2"]?.previousID == nil)
		#expect(runs["m1"]?.endsRun == true)
	}

	@Test func ownMessageCanBeEditedOnlyOnceSentAndNeverAnAgentsOrAnotherPersons() {
		#expect(message(1, "me", at: 0).canEdit(by: "me"))
		#expect(!message(1, "a", at: 0).canEdit(by: "me"))
		#expect(!message(1, "me", at: 0).canEdit(by: nil))
		var pending = message(1, "me", at: 0)
		pending.serverID = nil
		#expect(!pending.canEdit(by: "me"))
		var system = message(1, "me", at: 0)
		system.kind = "system"
		#expect(!system.canEdit(by: "me"))
	}
	// MARK: Day sections

	@Test func sectionsSplitAtEachDayAndKeepTheirMessages() {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = TimeZone(identifier: "UTC")!
		let items = ThreadLayout.items(
			for: [message(1, "a", at: 0), message(2, "b", at: 60), message(3, "a", at: 25 * 3600)], calendar: calendar)
		let sections = ThreadLayout.sections(for: items)
		#expect(sections.count == 2)
		#expect(sections.map(\.items.count) == [2, 1])
		#expect(sections.allSatisfy { $0.day != nil })
		#expect(sections[0].id != sections[1].id)
		// No separator is left inside a section: the header shows the day.
		#expect(sections.flatMap(\.items).allSatisfy { if case .daySeparator = $0 { false } else { true } })
	}

	@Test func theUnreadDividerStaysInsideItsDay() {
		let items = ThreadLayout.items(
			for: [message(1, "a", at: 0), message(2, "a", at: 10)], unreadAfter: 1, currentActorID: "me")
		let sections = ThreadLayout.sections(for: items)
		#expect(sections.count == 1)
		#expect(sections[0].items.contains { if case .unreadDivider = $0 { true } else { false } })
	}

	@Test func itemsBeforeAnyDayFormAnUndatedSection() {
		let items: [ThreadItem] = [.message(message(1, "a", at: 0), showsAuthor: true)]
		let sections = ThreadLayout.sections(for: items)
		#expect(sections.count == 1 && sections[0].day == nil && sections[0].id == "undated")
		#expect(ThreadLayout.sections(for: []).isEmpty)
	}
}
