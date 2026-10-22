import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("Live call card") struct LiveCallCardTests {
	private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

	private func msg(
		_ id: Int, _ who: String, _ text: String, at seconds: TimeInterval, human: Bool = false
	) -> ChatMessage {
		let mine = who == "me"
		var m = ChatMessage.confirmed(
			serverID: id, conversationID: "c", actorID: who, actorName: mine ? "Me" : who.capitalized,
			author: mine || human ? .human : .agent, content: text)
		m.createdAt = t0.addingTimeInterval(seconds)
		return m
	}

	private func record(ended: Bool = true, expanded: Bool? = nil) -> LiveCallRecord {
		LiveCallRecord(
			id: "call", conversationID: "c", leadName: "Relay", startedAt: t0,
			endedAt: ended ? t0.addingTimeInterval(421) : nil, expanded: expanded)
	}

	private func cards(_ items: [ThreadItem]) -> [LiveCallCard] {
		items.compactMap { if case .liveCall(let card) = $0 { card } else { nil } }
	}

	private func ids(_ items: [ThreadItem]) -> [String] {
		items.compactMap { if case .message(let m, _) = $0 { m.id } else { nil } }
	}

	@Test func foldsTheCallsMessagesIntoOneCardAtTheFirstOfThem() {
		let messages = [
			msg(1, "me", "before", at: -60),
			msg(2, "me", "what is blocked", at: 10),
			msg(3, "relay", "Three bets.", at: 14),
			msg(4, "me", "and who owns them", at: 40),
			msg(5, "relay", "Forge owns two.", at: 44),
			msg(6, "relay", "after the call", at: 900),
		]
		let items = ThreadLayout.items(for: messages, currentActorID: "me", calls: [record()])
		#expect(ids(items) == ["m1", "m6"])
		let kinds = items.compactMap { item -> String? in
			switch item {
			case .message(let m, _): m.id
			case .liveCall: "card"
			default: nil
			}
		}
		#expect(kinds == ["m1", "card", "m6"])
		let card = cards(items).first
		#expect(card?.messages.map(\.id) == ["m2", "m3", "m4", "m5"])
		#expect(card?.counts == "2 from you · 2 replies")
		#expect(card?.preview == "Relay: Forge owns two.")
	}

	@Test func aReplyJustAfterHangUpIsStillInTheCall() {
		let messages = [msg(2, "me", "hello", at: 10), msg(3, "relay", "late answer", at: 430)]
		let items = ThreadLayout.items(for: messages, currentActorID: "me", calls: [record()])
		#expect(ids(items).isEmpty)
		#expect(cards(items).first?.messages.count == 2)
	}

	@Test func anotherPersonsMessageStaysOutsideTheCardInOrder() {
		let messages = [
			msg(2, "me", "hello", at: 10),
			msg(3, "sam", "Sam here", at: 20, human: true),
			msg(4, "relay", "Hi", at: 25),
		]
		let items = ThreadLayout.items(for: messages, currentActorID: "me", calls: [record()])
		let order = items.compactMap { item -> String? in
			switch item {
			case .message(let m, _): m.id
			case .liveCall: "card"
			default: nil
			}
		}
		#expect(order == ["card", "m3"])
		#expect(cards(items).first?.messages.map(\.id) == ["m2", "m4"])
	}

	@Test func aCallNobodySpokeInStillGetsACardWhereItStarted() {
		let messages = [msg(1, "me", "before", at: -60), msg(2, "me", "much later", at: 5000)]
		let items = ThreadLayout.items(for: messages, currentActorID: "me", calls: [record()])
		let card = cards(items).first
		#expect(card?.messages.isEmpty == true)
		let order = items.compactMap { item -> String? in
			switch item {
			case .message(let m, _): m.id
			case .liveCall: "card"
			default: nil
			}
		}
		#expect(order == ["m1", "card", "m2"])
	}

	@Test func anOpenCallIsActiveAndOpenUntilYouClosedIt() {
		let open = LiveCallCard(record: record(ended: false), messages: [], currentActorID: "me")
		#expect(open.isActive && open.startsExpanded)
		let closed = LiveCallCard(record: record(ended: false, expanded: false), messages: [], currentActorID: "me")
		#expect(!closed.startsExpanded)
	}

	@Test func anEndedCallStartsClosedUnlessYouOpenedIt() {
		let ended = LiveCallCard(record: record(), messages: [], currentActorID: "me")
		#expect(!ended.isActive && !ended.startsExpanded)
		let opened = LiveCallCard(record: record(expanded: true), messages: [], currentActorID: "me")
		#expect(opened.startsExpanded)
	}

	@Test func titleNamesTheAgentAndGuestsAndDurationIsSeparate() {
		var withGuest = record()
		withGuest.guests = ["Forge"]
		let card = LiveCallCard(record: withGuest, messages: [], currentActorID: "me")
		#expect(card.title == "Live call with Relay, with Forge")
		#expect(card.durationText(now: t0) == "7:01")
		let plain = LiveCallCard(record: record(), messages: [], currentActorID: "me")
		#expect(plain.title == "Live call with Relay")
	}

	@Test func aRunningCallWithNoLinesYetHasNoCard() {
		let items = ThreadLayout.items(
			for: [msg(1, "me", "before", at: -60)], currentActorID: "me", calls: [record(ended: false)])
		#expect(cards(items).isEmpty)
	}

	// A voice call posts nothing to the chat; its lines are kept on the call record.
	private func voiceCall(ended: Bool = false) -> LiveCallRecord {
		var call = record(ended: ended)
		call.lines = [
			LiveCallLine(isYou: true, text: "What is blocked?", at: t0.addingTimeInterval(5)),
			LiveCallLine(isYou: false, text: "Three bets.", at: t0.addingTimeInterval(9)),
			LiveCallLine(isYou: true, text: "Who owns them?", at: t0.addingTimeInterval(20)),
		]
		return call
	}

	@Test func aVoiceCallsLinesShowInItsCardFromBothSidesWhileTheCallRuns() {
		let items = ThreadLayout.items(
			for: [msg(1, "me", "before", at: -60)], currentActorID: "me", calls: [voiceCall()])
		let card = cards(items).first
		#expect(card?.isActive == true)
		#expect(card?.messages.map(\.content) == ["What is blocked?", "Three bets.", "Who owns them?"])
		#expect(card?.messages.map { card?.isYou($0) } == [true, false, true])
		#expect(card?.messages.map(\.actorName) == ["You", "Relay", "You"])
		#expect(card?.counts == "2 from you · 1 reply")
		#expect(card?.preview == "You: Who owns them?")
	}

	@Test func aVoiceCallsLinesStayInTheCardAfterTheCallEnds() {
		let items = ThreadLayout.items(for: [], currentActorID: "me", calls: [voiceCall(ended: true)])
		let card = cards(items).first
		#expect(card?.isActive == false)
		#expect(card?.messages.count == 3)
		#expect(card?.counts == "2 from you · 1 reply")
	}

	@Test func voiceLinesAndChatMessagesInTheCallAreInterleavedInOrder() {
		let messages = [msg(2, "relay", "Posted from a tool", at: 12)]
		let items = ThreadLayout.items(for: messages, currentActorID: "me", calls: [voiceCall()])
		#expect(ids(items).isEmpty)
		#expect(
			cards(items).first?.messages.map(\.content)
				== ["What is blocked?", "Three bets.", "Posted from a tool", "Who owns them?"])
	}

	@Test func aCallSavedBeforeVoiceCallsKeptLinesStillLoads() throws {
		let old = Data(
			#"{"id":"c1","conversationID":"c","leadName":"Relay","guests":[],"startedAt":0,"spoken":["hi"]}"#.utf8)
		let decoded = try JSONDecoder().decode(LiveCallRecord.self, from: old)
		#expect(decoded.lines.isEmpty)
		#expect(decoded.spoken == ["hi"])
	}

	@Test func theLogKeepsAVoiceCallsLines() {
		let defaults = UserDefaults(suiteName: "livecall-\(UUID().uuidString)")!
		let log = LiveCallLog(defaults: defaults)
		log.save(record(ended: false))
		log.update("call") { $0.lines.append(LiveCallLine(isYou: false, text: "Hello", at: t0)) }
		#expect(log.records(for: "c").first?.lines.map(\.text) == ["Hello"])
	}

	@Test func objectsLinkedInTheCallBecomeChips() {
		let link = "[Fix the quota guard](https://maskin.io/ws/objects/obj1)"
		let card = LiveCallCard(
			record: record(), messages: [msg(3, "relay", "See \(link)", at: 14)], currentActorID: "me")
		#expect(card.mentioned.map(\.title) == ["Fix the quota guard"])
	}

	@Test func theLogKeepsTheExpandedState() {
		let defaults = UserDefaults(suiteName: "livecall-\(UUID().uuidString)")!
		let log = LiveCallLog(defaults: defaults)
		log.save(record())
		log.update("call") { $0.expanded = true }
		#expect(log.records(for: "c").first?.expanded == true)
		#expect(log.records(for: "other").isEmpty)
	}
}
