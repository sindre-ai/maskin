import Foundation
import Testing

@testable import MaskinCore

private func row(_ id: Int, _ json: String, stream: String = "stdout") -> SessionLogRow {
	SessionLogRow(id: id, stream: stream, content: json, createdAt: Date(timeIntervalSince1970: Double(id)))
}

private func user(_ id: Int, message: Int) -> SessionLogRow {
	row(id, #"{"type":"user","maskin_message_id":\#(message),"message":{"content":"hi"}}"#)
}

private func toolUse(_ id: Int, _ toolID: String, _ name: String, _ input: String) -> SessionLogRow {
	row(id, #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"\#(toolID)","name":"\#(name)","input":\#(input)}]}}"#)
}

private func toolResult(_ id: Int, _ toolID: String, _ text: String, error: Bool = false) -> SessionLogRow {
	row(id, #"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"\#(toolID)","is_error":\#(error),"content":"\#(text)"}]}}"#)
}

private func result(_ id: Int, error: Bool = false) -> SessionLogRow {
	row(id, #"{"type":"result","subtype":"success","is_error":\#(error),"result":"done"}"#)
}

@Suite("ActivityLogParser")
struct ActivityLogParserTests {
	@Test("splits the log into one turn per tagged user message")
	func segments() {
		let turns = ActivityLogParser.turns(
			from: [
				user(1, message: 10), toolUse(2, "t1", "Read", #"{"file_path":"/a/A.swift"}"#),
				toolResult(3, "t1", "contents"), result(4), user(5, message: 11),
				toolUse(6, "t2", "Bash", #"{"command":"ls"}"#), toolResult(7, "t2", "ok"), result(8),
			], sessionID: "s")
		#expect(turns.map(\.messageID) == [10, 11])
		#expect(turns.allSatisfy { $0.sessionID == "s" && $0.status == .completed })
		#expect(turns[0].steps.map(\.label) == ["Read A.swift"])
		#expect(turns[0].duration == 3)
	}

	@Test("pairs a tool call with its result: done with a preview, or failed")
	func pairing() {
		let turns = ActivityLogParser.turns(
			from: [
				user(1, message: 1), toolUse(2, "a", "Read", #"{"file_path":"/x"}"#),
				toolResult(3, "a", "file body"), toolUse(4, "b", "Bash", #"{"command":"false"}"#),
				toolResult(5, "b", "exit 1", error: true), result(6),
			])
		let steps = turns[0].steps
		#expect(steps[0].status == .completed)
		#expect(steps[0].output == "file body")
		#expect(steps[1].status == .failed)
		#expect(steps[1].output == "exit 1")
		#expect(!turns[0].failed)
	}

	@Test("the newest unanswered tool call of an open turn is running; the turn is too")
	func running() {
		let turns = ActivityLogParser.turns(
			from: [
				user(1, message: 1), toolUse(2, "a", "Read", #"{"file_path":"/x"}"#),
				toolUse(3, "b", "Grep", #"{"pattern":"q"}"#),
			])
		#expect(turns[0].isRunning)
		#expect(turns[0].steps.map(\.status) == [.completed, .running])
		#expect(turns[0].currentStep?.label == "Searched for “q”")
	}

	@Test("an errored result fails the turn and settles any step still running")
	func failure() {
		let turns = ActivityLogParser.turns(
			from: [user(1, message: 1), toolUse(2, "a", "Read", #"{"file_path":"/x"}"#), result(3, error: true)])
		#expect(turns[0].failed)
		#expect(turns[0].steps[0].status == .failed)
	}

	@Test("the reply tool marks the turn as containing a reply and swallows the wrap-up text")
	func reply() {
		let turns = ActivityLogParser.turns(
			from: [
				user(1, message: 1),
				toolUse(2, "r", "mcp__maskin__post_conversation_message", #"{"content":"yo"}"#),
				row(3, #"{"type":"assistant","message":{"content":[{"type":"text","text":"Replied."}]}}"#),
				result(4),
			])
		#expect(turns[0].containsReply)
		#expect(turns[0].steps.map(\.label) == ["Replied to the conversation"])
	}

	@Test("thinking, text and stderr become steps; lines before the first tagged turn are dropped")
	func otherKinds() {
		let turns = ActivityLogParser.turns(
			from: [
				toolUse(1, "orphan", "Read", #"{"file_path":"/x"}"#), user(2, message: 5),
				row(3, #"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Looking   now"}]}}"#),
				row(4, "boom", stream: "stderr"), result(5),
			])
		#expect(turns.count == 1)
		#expect(turns[0].steps.map(\.kind) == [.thinking, .text, .error])
		#expect(turns[0].steps[1].label == "Looking now")
	}

	@Test("a long turn keeps its newest steps and says it was cut")
	func capped() {
		var rows = [user(1, message: 1)]
		for i in 0..<130 { rows.append(toolUse(2 + i, "t\(i)", "Read", #"{"file_path":"/f\#(i)"}"#)) }
		let turn = ActivityLogParser.turns(from: rows)[0]
		#expect(turn.steps.count == ActivityLogParser.maxSteps)
		#expect(turn.stepsTruncated)
		#expect(turn.steps.last?.label == "Read f129")
	}

	@Test("decodes the logs response and sorts it by id")
	func decode() throws {
		let json = #"[{"id":2,"sessionId":"s","stream":"stdout","content":"b","createdAt":"2026-01-01T00:00:01.000Z"},{"id":1,"sessionId":"s","stream":"stderr","content":"a","createdAt":null},{"nope":1}]"#
		let rows = try HTTPSessionActivitySource.decodeRows(Data(json.utf8))
		#expect(rows.map(\.id) == [1, 2])
		#expect(rows[1].createdAt != nil)
	}
}
