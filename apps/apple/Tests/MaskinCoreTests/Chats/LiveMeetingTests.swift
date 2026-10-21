import Foundation
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

	@Test func noteWithTurnsRoundTrips() {
		let title = LiveMeetingFormat.endNote(lead: "Relay", guests: ["Forge"], seconds: 421)
		let note = LiveMeetingNote(
			title: title,
			turns: [
				.init(speaker: "You", text: "what is blocked right now", isYou: true),
				.init(speaker: "Relay", text: "Three bets.\n\nSee **Billing**.", isYou: false),
			])
		let parsed = LiveMeetingNote.parse(note.markdown)
		#expect(parsed?.title == "Live meeting with Relay, with Forge · 7:01")
		#expect(parsed?.heading == "Live meeting with Relay, with Forge")
		#expect(parsed?.durationText == "7:01")
		#expect(parsed?.turns.map(\.isYou) == [true, false])
		#expect(parsed?.turns.last?.text == "Three bets. See **Billing**.")
		#expect(parsed?.youCount == 1 && parsed?.agentCount == 1)
		#expect(parsed?.lastAgentTurn?.speaker == "Relay")
	}

	@Test func emptyCallSaysNoSpeechWasCaptured() {
		let note = LiveMeetingNote(title: "Live meeting with Relay · 0:42", turns: [])
		#expect(note.markdown.hasSuffix(LiveMeetingNote.emptyText))
		let parsed = LiveMeetingNote.parse(note.markdown)
		#expect(parsed?.turns.isEmpty == true)
	}

	@Test func ordinaryMessagesAreNotNotes() {
		#expect(LiveMeetingNote.parse("hello") == nil)
		#expect(LiveMeetingNote.parse("Live meeting with Relay · 0:42") == nil)
		#expect(LiveMeetingNote.parse("Live meeting with the team · tomorrow at nine") == nil)
	}

	@Test func longTranscriptKeepsTheLatestLines() {
		let turns = (0..<60).map {
			LiveMeetingTurn(speaker: "Relay", text: "line \($0) " + String(repeating: "x", count: 1000), isYou: false)
		}
		let markdown = LiveMeetingNote(title: "Live meeting with Relay · 9:00", turns: turns).markdown
		#expect(markdown.count < LiveMeetingNote.maxTranscriptLength + 500)
		#expect(markdown.contains("line 59"))
		#expect(!markdown.contains("line 0 "))
		#expect(markdown.contains("earlier lines left out"))
	}

	@Test func summaryPointsAtTheThreadInsteadOfRepeatingIt() {
		let turns: [LiveMeetingTurn] = [
			.init(speaker: "You", text: "what is blocked", isYou: true),
			.init(speaker: "Relay", text: "Three bets.", isYou: false),
			.init(speaker: "You", text: "who owns them", isYou: true),
			.init(speaker: "Relay", text: "Forge owns two.", isYou: false),
		]
		let note = LiveMeetingNote.summary(title: "Live meeting with Relay · 7:01", turns: turns)
		#expect(!note.markdown.contains("who owns them"))
		let parsed = LiveMeetingNote.parse(note.markdown)
		#expect(parsed?.isSummary == true)
		#expect(parsed?.youCount == 2 && parsed?.agentCount == 2)
		#expect(parsed?.firstYouTurn?.text == "what is blocked")
		#expect(parsed?.lastAgentTurn?.text == "Forge owns two.")
		#expect(parsed?.durationText == "7:01")
	}

	@Test func emptySummaryStillSaysNoSpeechWasCaptured() {
		let note = LiveMeetingNote.summary(title: "Live meeting with Relay · 0:42", turns: [])
		#expect(note.markdown.hasSuffix(LiveMeetingNote.emptyText))
	}
}
