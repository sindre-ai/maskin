import Testing

@testable import MaskinCore

@Suite("LiveMeeting") struct LiveMeetingTests {
	@Test func formatsDurations() {
		#expect(LiveMeetingFormat.duration(0) == "0:00")
		#expect(LiveMeetingFormat.duration(42.9) == "0:42")
		#expect(LiveMeetingFormat.duration(725) == "12:05")
		#expect(LiveMeetingFormat.duration(3723) == "1:02:03")
		#expect(LiveMeetingFormat.duration(-5) == "0:00")
	}

	@Test func endNoteNamesGuests() {
		#expect(LiveMeetingFormat.endNote(lead: "Relay", guests: [], seconds: 42) == "Live meeting with Relay · 0:42")
		#expect(
			LiveMeetingFormat.endNote(lead: "Relay", guests: ["Forge"], seconds: 42)
				== "Live meeting with Relay, with Forge · 0:42")
		#expect(
			LiveMeetingFormat.endNote(lead: "Relay", guests: ["Forge", "Quill", "Sentinel"], seconds: 65)
				== "Live meeting with Relay, with Forge, Quill and Sentinel · 1:05")
	}

	@Test func labelsAndNotes() {
		#expect(LiveMeetingKind.adHoc.label == "LIVE · AD HOC MEETING")
		#expect(LiveMeetingKind.dailyBriefing.label == "LIVE · DAILY BRIEFING")
		#expect(LiveMeetingKind.adHoc.postsNote)
		#expect(!LiveMeetingKind.dailyBriefing.postsNote)
	}
}

@Suite("NewConversationDraft") struct NewConversationDraftTests {
	private let chief = ChatActor(
		participant: ChatParticipant(id: "cos", name: "Chief of Staff", kind: .agent), isSystem: true)
	private let forge = ChatActor(participant: ChatParticipant(id: "forge", name: "Forge", kind: .agent))
	private let ida = ChatActor(participant: ChatParticipant(id: "ida", name: "Ida", kind: .human))
	private let me = ChatActor(participant: ChatParticipant(id: "me", name: "Me", kind: .human))

	@Test func defaultsToChiefOfStaffOnce() {
		var draft = NewConversationDraft()
		draft.applyDefault(actors: [], excluding: "me")
		#expect(draft.recipientIDs.isEmpty)
		draft.applyDefault(actors: [forge, chief, me], excluding: "me")
		#expect(draft.recipientIDs == ["cos"])
		draft.remove("cos")
		draft.applyDefault(actors: [forge, chief, me], excluding: "me")
		#expect(draft.recipientIDs.isEmpty)
	}

	@Test func morePeopleMakeAGroup() {
		var draft = NewConversationDraft()
		draft.toggle("cos")
		#expect(!draft.isGroup)
		draft.toggle("forge")
		#expect(draft.isGroup)
		#expect(draft.recipientIDs == ["cos", "forge"])
		draft.toggle("cos")
		#expect(draft.recipientIDs == ["forge"])
	}

	@Test func offersEveryoneElseChiefFirst() {
		var draft = NewConversationDraft()
		draft.toggle("forge")
		let offered = draft.addable(from: [ida, forge, me, chief], excluding: "me")
		#expect(offered.map(\.id) == ["cos", "ida"])
	}
}

@Suite("UnreadChats") struct UnreadChatsTests {
	@Test func countsChatsNotMessages() {
		let chats = [
			ConversationSummary(id: "a", title: "A", unreadCount: 5),
			ConversationSummary(id: "b", title: "B", unreadCount: 0),
			ConversationSummary(id: "c", title: "C", unreadCount: 1),
		]
		#expect(chats.unreadChatCount == 2)
		#expect([ConversationSummary]().unreadChatCount == 0)
	}
}

@Suite("ChiefOfStaffLiveChat")
struct ChiefOfStaffLiveChatTests {
	private func chat(
		_ id: String, title: String = "Chief of Staff", people: [String] = ["chief", "me"],
		at seconds: TimeInterval = 0, archived: Bool = false
	) -> ConversationSummary {
		ConversationSummary(
			id: id, title: title, lastMessageAt: Date(timeIntervalSince1970: seconds),
			archived: archived,
			participants: people.map { ChatParticipant(id: $0, name: $0, kind: .agent) })
	}

	@Test func picksTheNewestOneToOneChat() {
		let picked = ChiefOfStaffLiveChat.pick(
			from: [chat("old", at: 1), chat("new", at: 9)], chiefID: "chief",
			excludingTitle: "Daily briefing")
		#expect(picked?.id == "new")
	}

	@Test func skipsTheBriefingGroupArchivedAndOtherAgents() {
		let picked = ChiefOfStaffLiveChat.pick(
			from: [
				chat("brief", title: "Daily briefing", at: 9),
				chat("group", people: ["chief", "me", "x"], at: 9),
				chat("archived", at: 9, archived: true),
				chat("other", people: ["x", "me"], at: 9),
			], chiefID: "chief", excludingTitle: "Daily briefing")
		#expect(picked == nil)
	}
}
