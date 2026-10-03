import Foundation
import Testing

@testable import MaskinCore

// Fixtures follow the `GET /api/sessions/{id}/activity` contract (snake_case, ISO-8601 with
// fractional seconds, oldest turn first).

/// A turn that dies midway: two tools finish, the third fails, no reply is ever posted.
let failedMidwayFixture = """
	{
	  "session_id": "s1",
	  "turns": [{
	    "message_id": 42,
	    "started_at": "2026-01-01T00:00:01.000Z",
	    "finished_at": "2026-01-01T00:00:09.500Z",
	    "status": "failed",
	    "contains_reply": false,
	    "result": { "text": "Credit balance too low", "is_error": true, "log_id": 1210 },
	    "steps": [
	      { "id": "1201-0", "kind": "thinking", "label": "Thinking…",
	        "started_at": "2026-01-01T00:00:01.000Z", "finished_at": "2026-01-01T00:00:02.000Z", "status": "completed" },
	      { "id": "1202-0", "kind": "tool_use", "label": "Using Read", "detail": "/x.ts",
	        "started_at": "2026-01-01T00:00:02.000Z", "finished_at": "2026-01-01T00:00:03.000Z", "status": "completed" },
	      { "id": "1203-0", "kind": "tool_use", "label": "Using Bash", "detail": "pnpm test",
	        "started_at": "2026-01-01T00:00:03.000Z", "finished_at": "2026-01-01T00:00:09.500Z", "status": "failed" },
	      { "id": "1210-stderr", "kind": "error", "label": "Credit balance too low",
	        "started_at": "2026-01-01T00:00:09.500Z", "finished_at": null, "status": "failed" }
	    ],
	    "steps_truncated": false
	  }],
	  "oldest_log_id": 1190,
	  "has_older": false
	}
	"""

/// A turn that asks the human a question: it ends after the question tool, still running.
let questionFixture = """
	{
	  "session_id": "s2",
	  "turns": [{
	    "message_id": 7,
	    "started_at": "2026-01-01T00:00:01.000Z",
	    "finished_at": null,
	    "status": "running",
	    "contains_reply": false,
	    "result": null,
	    "steps": [
	      { "id": "90-0", "kind": "tool_use", "label": "Using Grep", "detail": "TODO",
	        "started_at": "2026-01-01T00:00:01.000Z", "finished_at": "2026-01-01T00:00:02.000Z", "status": "completed" },
	      { "id": "91-0", "kind": "tool_use", "label": "Asking a question",
	        "started_at": "2026-01-01T00:00:02.000Z", "finished_at": null, "status": "running" }
	    ],
	    "steps_truncated": false
	  }],
	  "oldest_log_id": 80,
	  "has_older": true
	}
	"""

/// A turn that produced nothing at all (a session that opened and closed).
let emptyTurnFixture = """
	{
	  "session_id": "s3",
	  "turns": [{
	    "message_id": 3, "started_at": null, "finished_at": null, "status": "completed",
	    "contains_reply": false, "result": null, "steps": [], "steps_truncated": false
	  }],
	  "oldest_log_id": null,
	  "has_older": false
	}
	"""

@Suite("ActivityParser")
struct ActivityParserTests {
	private func parse(_ json: String) throws -> SessionActivity {
		try ActivityParser.parse(Data(json.utf8))
	}

	@Test("a turn that fails midway keeps its steps and reads as failed")
	func failedMidway() throws {
		let activity = try parse(failedMidwayFixture)
		let turn = try #require(activity.turns.first)
		#expect(activity.sessionID == "s1")
		#expect(activity.oldestLogID == 1190)
		#expect(turn.messageID == 42)
		#expect(turn.status == .failed)
		#expect(turn.failed)
		#expect(turn.steps.map(\.id) == ["1201-0", "1202-0", "1203-0", "1210-stderr"])
		#expect(turn.steps.map(\.kind) == [.thinking, .toolUse, .toolUse, .error])
		#expect(turn.steps[2].status == .failed)
		#expect(turn.steps[1].detail == "/x.ts")
		#expect(turn.result == ActivityResult(text: "Credit balance too low", isError: true, logID: 1210))
		#expect(turn.summary == "Failed after 4 steps")
		#expect(turn.duration == 8.5)
	}

	@Test("a turn with a question is still running and emphasizes the open step")
	func questionTurn() throws {
		let turn = try #require(try parse(questionFixture).turns.first)
		#expect(turn.isRunning)
		#expect(turn.finishedAt == nil)
		#expect(turn.currentStep?.id == "91-0")
		#expect(turn.currentStep?.label == "Asking a question")
		#expect(try parse(questionFixture).hasOlder)
	}

	@Test("an empty turn parses to no steps and a quiet summary")
	func emptyTurn() throws {
		let turn = try #require(try parse(emptyTurnFixture).turns.first)
		#expect(turn.steps.isEmpty)
		#expect(turn.currentStep == nil)
		#expect(turn.startedAt == nil)
		#expect(turn.summary == "No steps")
		#expect(!turn.failed)
	}

	@Test("no turns at all is a valid, empty page")
	func noTurns() throws {
		let page = try parse(#"{"session_id":"s","turns":[],"oldest_log_id":null,"has_older":false}"#)
		#expect(page.turns.isEmpty)
		#expect(!page.hasOlder)
	}

	@Test("unknown kinds, bad dates and bad statuses degrade instead of dropping the turn")
	func tolerant() throws {
		let json = """
			{"session_id":"s","turns":[{"message_id":1,"status":"weird","steps":[
			  {"id":"1-0","kind":"mystery","label":"Hmm","started_at":"not a date","status":"also weird"},
			  {"kind":"text","label":"no id so skipped"}
			]}]}
			"""
		let turn = try #require(try parse(json).turns.first)
		#expect(turn.status == .completed)
		#expect(turn.steps.count == 1)
		#expect(turn.steps[0].kind == .text)
		#expect(turn.steps[0].startedAt == nil)
		#expect(turn.steps[0].status == .completed)
	}

	@Test("a turn without a message id can't be placed in a thread and is skipped")
	func skipsUnplaceable() throws {
		let page = try parse(#"{"session_id":"s","turns":[{"status":"completed","steps":[]}]}"#)
		#expect(page.turns.isEmpty)
	}

	@Test("a body that isn't an activity envelope throws")
	func rejectsGarbage() {
		#expect(throws: ActivityParser.ParseError.self) { try ActivityParser.parse(Data("[]".utf8)) }
		#expect(throws: ActivityParser.ParseError.self) { try ActivityParser.parse(Data("nope".utf8)) }
		#expect(throws: ActivityParser.ParseError.self) {
			try ActivityParser.parse(Data(#"{"error":{"code":"NOT_FOUND"}}"#.utf8))
		}
	}

	@Test("steps, labels, details and result text are capped to the contract")
	func caps() throws {
		let long = String(repeating: "x", count: 1000)
		let steps = (0..<150).map { #"{"id":"\#($0)-0","kind":"text","label":"\#(long)","detail":"\#(long)"}"# }
		let json =
			#"{"session_id":"s","turns":[{"message_id":1,"result":{"text":"\#(String(repeating: "r", count: 9000))","is_error":false},"steps":[\#(steps.joined(separator: ","))]}]}"#
		let turn = try #require(try parse(json).turns.first)
		#expect(turn.steps.count == ActivityParser.maxSteps)
		#expect(turn.stepsTruncated)
		#expect(turn.steps[0].label.count == ActivityParser.maxLabel)
		#expect(turn.steps[0].detail?.count == ActivityParser.maxDetail)
		#expect(turn.result?.text.count == ActivityParser.maxResultText)
	}

	@Test("summary pluralizes and shows duration")
	func summary() {
		let start = Date(timeIntervalSince1970: 1000)
		let one = ActivityTurn(
			sessionID: "s", messageID: 1, startedAt: start, finishedAt: start.addingTimeInterval(8),
			steps: [ActivityStep(id: "a", kind: .text, label: "x")])
		#expect(one.summary == "1 step · 8s")
		#expect(ActivityTurn.format(75) == "1m 15s")
	}
}
