import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("LiveCallSpans") struct LiveCallSpansTests {
	private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

	private func msg(_ id: Int, mine: Bool, _ text: String, at seconds: TimeInterval) -> ChatMessage {
		var m = ChatMessage.confirmed(
			serverID: id, conversationID: "c", actorID: mine ? "me" : "relay", actorName: mine ? "Me" : "Relay",
			author: mine ? .human : .agent, content: text)
		m.createdAt = t0.addingTimeInterval(seconds)
		return m
	}

	private var record: LiveCallRecord {
		LiveCallRecord(
			id: "call", conversationID: "c", leadName: "Relay", startedAt: t0,
			endedAt: t0.addingTimeInterval(421), spoken: ["what is blocked"])
	}

	@Test func marksTheCallsMessagesAndItsEnds() {
		let messages = [
			msg(1, mine: true, "before the call", at: -60),
			msg(2, mine: true, "what is blocked", at: 10),
			msg(3, mine: false, "Three bets.", at: 14),
			msg(4, mine: true, "typed during the call", at: 100),
			msg(5, mine: false, "Answer after hang-up", at: 430),
			msg(6, mine: true, "long after", at: 900),
		]
		let spans = LiveCallSpans(records: [record], messages: messages, currentActorID: "me")
		#expect(spans.roles[messages[0].id] == nil && spans.roles[messages[5].id] == nil)
		#expect(spans.roles[messages[1].id]?.isFirst == true)
		#expect(spans.roles[messages[1].id]?.isSpoken == true)
		#expect(spans.roles[messages[3].id]?.isSpoken == false)
		#expect(spans.roles[messages[4].id]?.isLast == true)
		let note = spans.summary(for: record)
		#expect(note?.durationText == "7:01")
		#expect(note?.youCount == 2 && note?.agentCount == 2)
	}

	@Test func anOpenCallHasNoSummary() {
		var open = record
		open.endedAt = nil
		let spans = LiveCallSpans(
			records: [open], messages: [msg(2, mine: true, "hello", at: 5)], currentActorID: "me")
		#expect(spans.roles.count == 1)
		#expect(spans.summary(for: open) == nil)
	}

	@Test func logKeepsRecordsPerConversation() {
		let defaults = UserDefaults(suiteName: "livecall-\(UUID().uuidString)")!
		let log = LiveCallLog(defaults: defaults)
		log.save(record)
		log.update("call") { $0.spoken.append("more") }
		#expect(log.records(for: "c").first?.spoken == ["what is blocked", "more"])
		#expect(log.records(for: "other").isEmpty)
	}
}
