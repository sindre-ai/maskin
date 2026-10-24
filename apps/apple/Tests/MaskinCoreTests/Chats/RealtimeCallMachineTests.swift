import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

@Suite("RealtimeCallMachine") struct RealtimeCallMachineTests {
	private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
	private func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }
	private func event(_ type: String, transcript: String? = nil) -> RealtimeEvent {
		RealtimeEvent(type: type, transcript: transcript)
	}

	@Test("a turn goes listening, thinking, speaking, listening")
	func turn() {
		var m = RealtimeCallMachine()
		_ = m.handle(event("session.created"), at: at(0))
		#expect(m.phase == .listening)
		_ = m.handle(event("input_audio_buffer.speech_started"), at: at(1))
		#expect(m.phase == .listening)
		_ = m.handle(event("input_audio_buffer.speech_stopped"), at: at(3))
		#expect(m.phase == .thinking)
		_ = m.handle(event("output_audio_buffer.started"), at: at(4))
		#expect(m.phase == .speaking)
		_ = m.handle(event("output_audio_buffer.stopped"), at: at(9))
		#expect(m.phase == .listening)
	}

	@Test("barge-in: the server clearing the audio puts the screen back to listening")
	func bargeIn() {
		var m = RealtimeCallMachine()
		_ = m.handle(event("output_audio_buffer.started"), at: at(0))
		_ = m.handle(event("output_audio_buffer.cleared"), at: at(2))
		#expect(m.phase == .listening)
	}

	@Test("a tool call shows as thinking, with a tag in the transcript")
	func toolCall() {
		var m = RealtimeCallMachine()
		let search = RealtimeEvent(
			type: "response.function_call_arguments.done", callId: "c1", name: "search_objects",
			arguments: #"{"q":"pricing bet"}"#)
		#expect(m.handle(search, at: at(0)).isEmpty)
		#expect(m.phase == .thinking)
		#expect(m.lines.last?.kind == .tool)
		#expect(m.lines.last?.text == "searching for pricing bet…")
	}

	@Test("with tools unavailable, the tool call is answered with an error and the model is asked to continue")
	func toolsUnavailable() throws {
		var m = RealtimeCallMachine()
		m.toolsAvailable = false
		let call = RealtimeEvent(
			type: "response.function_call_arguments.done", callId: "c9", name: "get_objects", arguments: "{}")
		let commands = m.handle(call, at: at(0))
		#expect(commands.count == 2)
		guard case .sendEvent(let first) = commands[0], case .sendEvent(let second) = commands[1] else {
			Issue.record("expected two events")
			return
		}
		let object = try #require(
			JSONSerialization.jsonObject(with: Data(first.utf8)) as? [String: Any])
		#expect(object["type"] as? String == "conversation.item.create")
		let item = try #require(object["item"] as? [String: Any])
		#expect(item["type"] as? String == "function_call_output")
		#expect(item["call_id"] as? String == "c9")
		#expect((item["output"] as? String)?.contains("voice_channel_unavailable") == true)
		#expect(second == #"{"type":"response.create"}"#)
	}

	@Test("finished turns become transcript lines; the agent's last words are kept for captions")
	func transcript() {
		var m = RealtimeCallMachine()
		_ = m.handle(
			event("conversation.item.input_audio_transcription.completed", transcript: "  what changed? "),
			at: at(0))
		_ = m.handle(event("response.output_audio_transcript.done", transcript: "Two bets moved."), at: at(1))
		_ = m.handle(event("response.audio_transcript.done", transcript: "  "), at: at(2))
		#expect(m.lines.map(\.text) == ["what changed?", "Two bets moved."])
		#expect(m.lastAgentWords == "Two bets moved.")
	}

	@Test("audio seconds count the call and the agent's speech, including an utterance still going")
	func audioSeconds() {
		var m = RealtimeCallMachine()
		_ = m.handle(event("session.created"), at: at(0))
		_ = m.handle(event("output_audio_buffer.started"), at: at(10))
		_ = m.handle(event("output_audio_buffer.stopped"), at: at(14))
		_ = m.handle(event("output_audio_buffer.started"), at: at(20))
		#expect(m.inputSeconds(at: at(30)) == 30)
		#expect(m.outputSeconds(at: at(30)) == 14)
	}

	@Test("tapping to interrupt cancels the response and clears the audio")
	func interrupt() {
		var m = RealtimeCallMachine()
		_ = m.handle(event("output_audio_buffer.started"), at: at(0))
		let commands = m.interrupted(at: at(1))
		#expect(commands.count == 2)
		#expect(m.phase == .listening)
		#expect(m.interrupted(at: at(2)).isEmpty)
	}

	@Test("events it does not know, or that are not JSON, change nothing")
	func unknown() {
		var m = RealtimeCallMachine()
		let before = m
		_ = m.handle(event("rate_limits.updated"), at: at(0))
		#expect(m == before)
		#expect(RealtimeEvent.parse(Data("not json".utf8)) == nil)
		#expect(RealtimeEvent.parse(Data(#"{"type":"session.created"}"#.utf8))?.type == "session.created")
	}
}

@Suite("URLSessionVoiceCalls") struct URLSessionVoiceCallsTests {
	private let calls = URLSessionVoiceCalls(
		baseURL: URL(string: "https://example.test")!, clientSource: "ios",
		credentials: { MaskinCredentials(apiKey: "ank_test", workspaceId: "ws-1") })

	@Test("requests carry the key, the workspace and the client source")
	func request() throws {
		let request = try calls.makeRequest(
			path: "voice-sessions", body: ["agent_actor_id": "a-1"],
			credentials: MaskinCredentials(apiKey: "ank_test", workspaceId: "ws-1"))
		#expect(request.url?.absoluteString == "https://example.test/api/voice-sessions")
		#expect(request.httpMethod == "POST")
		#expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ank_test")
		#expect(request.value(forHTTPHeaderField: "X-Workspace-Id") == "ws-1")
		#expect(request.value(forHTTPHeaderField: "X-Client-Source") == "ios")
	}

	@Test("the create body carries the chat the call was started from, and leaves it out otherwise")
	func createBody() throws {
		func json(_ body: URLSessionVoiceCalls.CreateBody) throws -> [String: String] {
			let data = try JSONEncoder().encode(body)
			return try #require(try JSONSerialization.jsonObject(with: data) as? [String: String])
		}
		let fromChat = try json(.init(agent_actor_id: "a-1", conversation_id: "c-1"))
		#expect(fromChat == ["agent_actor_id": "a-1", "conversation_id": "c-1"])
		let fresh = try json(.init(agent_actor_id: "a-1", conversation_id: nil))
		#expect(fresh == ["agent_actor_id": "a-1"])
	}

	@Test("status codes map to the failure the call screen reacts to")
	func failures() {
		let rate = Data(#"{"error":{"code":"RATE_LIMITED","message":"x"},"retry_after_seconds":120}"#.utf8)
		let message = Data(#"{"error":{"code":"INTERNAL_ERROR","message":"Vendor connect failed (status 500)"}}"#.utf8)
		#expect(URLSessionVoiceCalls.failure(status: 404, body: Data()) == .unavailable)
		#expect(URLSessionVoiceCalls.failure(status: 400, body: Data()) == .notAnAgent)
		#expect(URLSessionVoiceCalls.failure(status: 409, body: Data()) == .alreadyInCall)
		#expect(URLSessionVoiceCalls.failure(status: 429, body: rate) == .rateLimited(retryAfterSeconds: 120))
		#expect(
			URLSessionVoiceCalls.failure(status: 500, body: message)
				== .server("Vendor connect failed (status 500)"))
	}

	@Test("only the failures where the dictation call still works fall back to it")
	func fallbacks() {
		#expect(VoiceCallFailure.unavailable.shouldFallBack)
		#expect(VoiceCallFailure.notAnAgent.shouldFallBack)
		#expect(!VoiceCallFailure.alreadyInCall.shouldFallBack)
		#expect(!VoiceCallFailure.rateLimited(retryAfterSeconds: nil).shouldFallBack)
		#expect(!VoiceCallFailure.network("x").shouldFallBack)
	}
}
