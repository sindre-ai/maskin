import Foundation
import Testing

@testable import MaskinCore

@Suite("Chats list layout") struct ConversationListLayoutTests {
	private var calendar: Calendar {
		var c = Calendar(identifier: .gregorian)
		c.timeZone = TimeZone(identifier: "UTC")!
		return c
	}
	/// Wed 2026-09-30 15:00 UTC.
	private let now = Date(timeIntervalSince1970: 1_790_780_400)
	private func ago(days: Int, hours: Int = 0) -> Date {
		now.addingTimeInterval(-TimeInterval(days * 86_400 + hours * 3600))
	}
	private let us = Locale(identifier: "en_US")

	@Test func timeIsAClockToday() {
		let text = ChatListTime.label(for: ago(days: 0, hours: 2), now: now, calendar: calendar, locale: us)
		#expect(text.contains("1:00"))
		#expect(text.contains("PM"))
	}

	@Test func timeSaysYesterday() {
		#expect(ChatListTime.label(for: ago(days: 1), now: now, calendar: calendar, locale: us) == "Yesterday")
	}

	@Test func timeIsAWeekdayWithinTheWeek() {
		// 3 days before Wed is Sun.
		#expect(ChatListTime.label(for: ago(days: 3), now: now, calendar: calendar, locale: us) == "Sun")
	}

	@Test func olderTimeIsMonthAndDay() {
		#expect(ChatListTime.label(for: ago(days: 10), now: now, calendar: calendar, locale: us) == "Sep 20")
	}

	@Test func pinnedChatsAreSeparatedAndNotRepeated() {
		let all = [
			chatConvo("pin", last: ago(days: 5), pinned: true), chatConvo("a", last: ago(days: 0, hours: 1)),
		]
		let sections = ConversationGrouping.sections(
			all, by: .recent, currentActorID: "me", now: now, calendar: calendar)
		#expect(sections.pinned.map(\.id) == ["pin"])
		#expect(sections.groups.flatMap(\.items).map(\.id) == ["a"])
	}

	@Test func groupByAgentOrdersGroupsByNewestChat() {
		let cpo = ChatParticipant(id: "cpo", name: "CPO", kind: .agent)
		let all = [
			chatConvo("1", last: ago(days: 4), participants: [chatMe, cpo]),
			chatConvo("2", last: ago(days: 1), participants: [chatMe, chatRelay]),
			chatConvo("3", last: ago(days: 3), participants: [chatMe, chatSam]),
			chatConvo("4", last: ago(days: 2), participants: [chatMe, cpo]),
		]
		let groups = ConversationGrouping.sections(
			all, by: .agent, currentActorID: "me", now: now, calendar: calendar
		).groups
		#expect(groups.map(\.label) == ["Relay", "CPO", "People"])
		#expect(groups[1].items.map(\.id) == ["4", "1"])
	}

	@Test func groupChatNeedsMoreThanOneOtherParty() {
		#expect(!chatConvo("a").isGroupChat(excluding: "me"))
		#expect(chatConvo("b", participants: [chatMe, chatRelay, chatSam]).isGroupChat(excluding: "me"))
	}

	@Test func counterpartPrefersAgents() {
		let c = chatConvo("b", participants: [chatMe, chatSam, chatRelay])
		#expect(c.counterpartName(excluding: "me") == "Relay")
	}

	@Test func roleLabels() {
		let human = ChatParticipant(id: "h", name: "Ida", kind: .human)
		#expect(PersonRoleLabel.label(for: human, memberRole: "owner", agentSummary: nil) == "Human · Owner")
		#expect(PersonRoleLabel.label(for: human, memberRole: nil, agentSummary: nil) == "Human")
		#expect(PersonRoleLabel.label(for: chatRelay, memberRole: nil, agentSummary: "CPO\nLong text") == "Agent · CPO")
		let sentence = String(repeating: "Does many things. ", count: 5)
		#expect(PersonRoleLabel.label(for: chatRelay, memberRole: nil, agentSummary: sentence) == "Agent")
		#expect(PersonRoleLabel.label(for: chatRelay, memberRole: nil, agentSummary: nil) == "Agent")
	}
}

@Suite("Chat handoffs") struct ChatHandoffTests {
	@Test func anAgentHandingWorkToAnotherAgentIsAHandoff() {
		let messages = [
			chatMsg(1, by: "me", "Please draft the brief"),
			chatMsg(2, by: "cos", name: "Chief", agent: true, "**Handing off** the draft to Relay\nDetails"),
		]
		let sessions = [
			ChatAgentSession(id: "s1", actorID: "cos", status: .completed, messageID: 1),
			ChatAgentSession(id: "s2", actorID: "relay", status: .running, messageID: 2),
		]
		let handoffs = ChatHandoffs.handoffs(sessions: sessions, messages: messages)
		#expect(handoffs.map(\.sessionID) == ["s2"])
		#expect(handoffs.first?.title == "Handing off the draft to Relay")
		#expect(handoffs.first?.triggerMessageID == 2)
	}

	@Test func anAgentAnsweringItsOwnMessageIsNot() {
		let messages = [chatMsg(1, by: "cos", name: "Chief", agent: true, "On it")]
		let sessions = [ChatAgentSession(id: "s", actorID: "cos", status: .running, messageID: 1)]
		#expect(ChatHandoffs.handoffs(sessions: sessions, messages: messages).isEmpty)
	}

	@Test func aSessionWithNoRecordedMessageIsNot() {
		let sessions = [ChatAgentSession(id: "s", actorID: "relay", status: .running)]
		#expect(ChatHandoffs.handoffs(sessions: sessions, messages: []).isEmpty)
	}
}

@Suite("Group chat header") struct GroupChatSummaryTests {
	private let people = [
		chatMe, ChatParticipant(id: "s", name: "Sebastian", kind: .human), chatRelay,
		ChatParticipant(id: "a", name: "CPO", kind: .agent), ChatParticipant(id: "b", name: "Dev", kind: .agent),
	]

	@Test func youComeFirstAndTheRestAreCounted() {
		#expect(GroupChatSummary.names(of: people, selfID: "me") == "You, Sebastian, Relay +2")
	}

	@Test func fewNamesAreAllListed() {
		#expect(GroupChatSummary.names(of: [chatMe, chatRelay], selfID: "me") == "You, Relay")
	}

	@Test func avatarsAreCappedAtFourAndPutYouLast() {
		let shown = GroupChatSummary.avatarParticipants(of: people, selfID: "me")
		#expect(shown.map(\.id) == ["s", "relay", "a", "b"])
	}
}

@Suite("ConversationsStore sections") @MainActor struct ConversationsSectionsTests {
	@Test func pinnedTilesLeaveTheGroupsAndSearchFlattensTheList() async {
		let api = FakeListAPI([chatConvo("pin", pinned: true), chatConvo("a", title: "Roadmap"), chatConvo("b")])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		var sections = store.sections(currentActorID: "me", now: chatT0)
		#expect(sections.pinned.map(\.id) == ["pin"])
		#expect(sections.groups.flatMap(\.items).map(\.id).sorted() == ["a", "b"])
		sections = store.sections(query: "road", currentActorID: "me", now: chatT0)
		#expect(sections.pinned.isEmpty)
		#expect(sections.groups.flatMap(\.items).map(\.id) == ["a"])
	}

	@Test func groupByAgentUsesTheStoresChoice() async {
		let api = FakeListAPI([chatConvo("a")])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		store.groupBy = .agent
		#expect(store.sections(currentActorID: "me", now: chatT0).groups.map(\.label) == ["Relay"])
	}
}
