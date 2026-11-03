import Foundation
import Testing

@testable import MaskinCore

@Suite("Team sections") struct TeamSectionsTests {
	private let ida = ChatParticipant(id: "ida", name: "Ida", kind: .human)
	private let sam = chatSam
	private let relay = chatRelay
	private let cpo = ChatParticipant(id: "cpo", name: "CPO", kind: .agent)

	private func ago(_ minutes: Int) -> Date { chatT0.addingTimeInterval(-TimeInterval(minutes * 60)) }

	@Test func oneRowPerPersonWithTheirConversationsNewestFirst() {
		let all = [
			chatConvo("old", last: ago(90), participants: [chatMe, relay]),
			chatConvo("new", last: ago(5), participants: [chatMe, relay]),
			chatConvo("sam", last: ago(30), participants: [chatMe, sam]),
		]
		let people = ConversationGrouping.people(all, currentActorID: "me")
		#expect(people.map(\.id) == ["relay", "sam"])
		#expect(people[0].conversations.map(\.id) == ["new", "old"])
		#expect(people[0].hasSeveral)
		#expect(people[1].kind == .human)
	}

	@Test func aGroupChatIsItsOwnRow() {
		let all = [
			chatConvo("g", title: "Launch", last: ago(1), participants: [chatMe, sam, relay]),
			chatConvo("d", last: ago(2), participants: [chatMe, relay]),
		]
		let people = ConversationGrouping.people(all, currentActorID: "me")
		#expect(people.map(\.name) == ["Launch", "Relay"])
		#expect(people[0].kind == .group)
		#expect(people[0].participants.map(\.id) == ["sam", "relay"])
	}

	@Test func humansComeBeforeAgentsEachNewestFirst() {
		let all = [
			chatConvo("r", last: ago(1), participants: [chatMe, relay]),
			chatConvo("s", last: ago(50), participants: [chatMe, sam]),
			chatConvo("i", last: ago(40), participants: [chatMe, ida]),
			chatConvo("c", last: ago(2), participants: [chatMe, cpo]),
		]
		let sections = ConversationGrouping.teamSections(all, currentActorID: "me")
		#expect(sections.people.map(\.id) == ["ida", "sam", "relay", "cpo"])
	}

	@Test func pinnedChatsAreTilesNotPeople() {
		let all = [
			chatConvo("p", last: ago(1), pinned: true, participants: [chatMe, relay]),
			chatConvo("s", last: ago(2), participants: [chatMe, sam]),
		]
		let sections = ConversationGrouping.teamSections(all, currentActorID: "me")
		#expect(sections.pinned.map(\.id) == ["p"])
		#expect(sections.people.map(\.id) == ["sam"])
	}

	@Test func unreadListsEveryoneWithUnreadItemsEvenPinned() {
		let all = [
			chatConvo("p", last: ago(1), pinned: true, unread: 2, participants: [chatMe, relay]),
			chatConvo("s", last: ago(2), unread: 1, participants: [chatMe, sam]),
			chatConvo("quiet", last: ago(3), participants: [chatMe, ida]),
		]
		let sections = ConversationGrouping.teamSections(all, currentActorID: "me")
		#expect(sections.unread.map(\.id) == ["relay", "sam"])
		#expect(sections.unreadConversationIDs == ["p", "s"])
	}

	@Test func aPersonsUnreadRowCountsOnlyTheirUnreadChats() {
		let all = [
			chatConvo("a", last: ago(1), unread: 2, participants: [chatMe, relay]),
			chatConvo("b", last: ago(2), unread: 3, participants: [chatMe, relay]),
			chatConvo("c", last: ago(3), participants: [chatMe, relay]),
		]
		let unread = ConversationGrouping.teamSections(all, currentActorID: "me").unread
		#expect(unread.count == 1)
		#expect(unread[0].unreadCount == 5)
		#expect(unread[0].conversations.map(\.id) == ["a", "b"])
		#expect(unread[0].rowSummary.title == "Relay")
		#expect(unread[0].rowSummary.unreadCount == 5)
	}

	@Test func peopleAreCappedAtFiveUntilAllAreAsked() {
		let actors = (0..<7).map { ChatParticipant(id: "p\($0)", name: "P\($0)", kind: .human) }
		let all = actors.enumerated().map { chatConvo("c\($0.offset)", last: ago($0.offset), participants: [chatMe, $0.element]) }
		let sections = ConversationGrouping.teamSections(all, currentActorID: "me")
		#expect(sections.visiblePeople(showAll: false).count == 5)
		#expect(sections.visiblePeople(showAll: true).count == 7)
		#expect(sections.morePeopleLabel(showAll: false) == "All 7 people & agents")
		#expect(sections.morePeopleLabel(showAll: true) == "Show fewer")
	}

	@Test func fiveOrFewerPeopleNeedNoExpander() {
		let all = [chatConvo("a", participants: [chatMe, sam])]
		#expect(ConversationGrouping.teamSections(all, currentActorID: "me").morePeopleLabel(showAll: false) == nil)
	}
}

@Suite("Team store") @MainActor struct TeamStoreTests {
	@Test func teamSectionsAreOnlyForTheActiveListWithoutASearch() async {
		let store = ConversationsStore(api: FakeListAPI([chatConvo("a", title: "Roadmap")]), events: nil)
		await store.refresh()
		#expect(store.teamSections(currentActorID: "me") != nil)
		#expect(store.teamSections(query: "road", currentActorID: "me") == nil)
		store.scope = .archived
		#expect(store.teamSections(currentActorID: "me") == nil)
	}

	@Test func markAllReadRecordsTheNewestMessageForEachUnreadChatOnly() async {
		let api = FakeListAPI([
			chatConvo("u1", unread: 2), chatConvo("u2", unread: 1), chatConvo("read"),
		])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		let result = await store.markRead(["u1", "u2", "read"])
		#expect(result.succeeded == 2)
		#expect(result.failed == 0)
		#expect(store.totalUnread == 0)
		let calls = await api.stateCalls
		#expect(calls.count == 2)
		#expect(calls.allSatisfy { $0.contains("read=100") })
	}

	@Test func markAllReadRollsBackAChatThatFails() async {
		let api = FakeListAPI([chatConvo("u1", unread: 2)])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		await api.setFailState(true)
		let result = await store.markRead(["u1"])
		#expect(result.failed == 1)
		#expect(store.conversation(id: "u1")?.unreadCount == 2)
		#expect(store.notice != nil)
	}
}
