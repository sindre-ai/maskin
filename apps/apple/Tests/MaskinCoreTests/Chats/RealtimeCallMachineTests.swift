import Foundation
import HTTPTypes
import MaskinAPI
import OpenAPIRuntime
import Testing

@testable import MaskinAPI
@testable import MaskinCore

@Suite("RealtimeCallMachine") struct RealtimeCallMachineTests {
	private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
	private func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }
	private func event(_ type: String, transcript: String? = nil) -> RealtimeEvent {
		RealtimeEvent(type: type, transcript: transcript)
	}

	@Test("the call is listening from the start and stays so when the edge opens, until someone speaks")
	func startsListening() {
		var machine = RealtimeCallMachine()
		#expect(machine.phase == .listening)
		_ = machine.handle(RealtimeEvent(type: "session.created"), at: at(0))
		_ = machine.handle(RealtimeEvent(type: "session.updated"), at: at(0.1))
		#expect(machine.phase == .listening)
		#expect(machine.lastAgentWords == nil)
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

	@Test("the call sends nothing when it connects: the server makes the agent greet")
	func sendsNothingOnConnect() {
		var m = RealtimeCallMachine()
		#expect(m.handle(event("session.created"), at: at(0)).isEmpty)
		#expect(m.handle(event("session.created"), at: at(1)).isEmpty)
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

/// Answers every request with one scripted status and body, and records what was sent.
private final class VoiceWire: ClientTransport, @unchecked Sendable {
	struct Seen { var method: String; var path: String; var headers: [String: String]; var body: Data }
	private let lock = NSLock()
	private var _seen: [Seen] = []
	var seen: [Seen] { lock.withLock { _seen } }
	let status: Int
	let json: String

	init(status: Int, json: String) {
		self.status = status
		self.json = json
	}

	func send(
		_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		var bytes = Data()
		if let body { for try await chunk in body { bytes.append(contentsOf: chunk) } }
		var headers: [String: String] = [:]
		for field in request.headerFields { headers[field.name.canonicalName] = field.value }
		lock.withLock {
			_seen.append(Seen(method: request.method.rawValue, path: request.path ?? "", headers: headers, body: bytes))
		}
		var response = HTTPResponse(status: .init(code: status))
		response.headerFields[.contentType] = "application/json"
		return (response, HTTPBody(json))
	}
}

private let errorBody = #"{"error":{"code":"x","message":"x"}}"#

@Suite("URLSessionVoiceCalls") struct URLSessionVoiceCallsTests {
	private func calls(_ transport: VoiceWire) -> URLSessionVoiceCalls {
		URLSessionVoiceCalls(
			client: Client(
				serverURL: URL(string: "https://example.test")!, transport: transport,
				middlewares: [
					MaskinAuthMiddleware(
						credentials: { MaskinCredentials(apiKey: "ank_test", workspaceId: "ws-1") },
						clientSource: "ios")
				]))
	}

	private func failure(_ status: Int, json: String = errorBody) async -> VoiceCallFailure? {
		do {
			_ = try await calls(VoiceWire(status: status, json: json)).create(agentActorID: "a-1", conversationID: nil)
			return nil
		} catch { return error as? VoiceCallFailure }
	}

	@Test("create posts to the voice route with the key, the workspace and the client source")
	func request() async throws {
		let transport = VoiceWire(status: 201, json: #"{"voice_session_id":"vs-1"}"#)
		let id = try await calls(transport).create(agentActorID: "a-1", conversationID: "c-1")
		#expect(id == "vs-1")
		let seen = try #require(transport.seen.first)
		#expect(seen.method == "POST" && seen.path == "/api/voice-sessions")
		#expect(seen.headers["authorization"] == "Bearer ank_test")
		#expect(seen.headers["x-workspace-id"] == "ws-1")
		#expect(seen.headers["x-client-source"] == "ios")
	}

	@Test("the create body carries the chat the call was started from, and leaves it out otherwise")
	func createBody() async throws {
		func sent(_ conversationID: String?) async throws -> [String: String] {
			let transport = VoiceWire(status: 201, json: #"{"voice_session_id":"vs-1"}"#)
			_ = try await calls(transport).create(agentActorID: "a-1", conversationID: conversationID)
			let body = try #require(transport.seen.first?.body)
			return try #require(try JSONSerialization.jsonObject(with: body) as? [String: String])
		}
		#expect(try await sent("c-1") == ["agent_actor_id": "a-1", "conversation_id": "c-1"])
		#expect(try await sent(nil) == ["agent_actor_id": "a-1"])
	}

	@Test("offer and hangup go to the session's own routes and read the answers")
	func offerAndHangup() async throws {
		let offerWire = VoiceWire(
			status: 200, json: #"{"sdp":"answer","tools_available":false,"persist_transcripts":true}"#)
		let answer = try await calls(offerWire).offer(
			voiceSessionID: "vs-1", sdp: "offer", noiseReduction: .nearField)
		#expect(answer == VoiceCallAnswer(sdp: "answer", toolsAvailable: false, persistTranscripts: true))
		#expect(offerWire.seen.first?.path == "/api/voice-sessions/vs-1/offer")
		let offerSeen = try #require(offerWire.seen.first)
		let offerBody = try #require(try JSONSerialization.jsonObject(with: offerSeen.body) as? [String: Any])
		#expect(offerBody["noise_reduction"] as? String == "near_field")

		let hangupWire = VoiceWire(
			status: 200,
			json:
				#"{"voice_session_id":"vs-1","status":"ended","ended_reason":"user_hangup","ended_at":null,"duration_ms":1000,"total_cost_usd":null,"conversation_id":"c-9"}"#
		)
		let conversationID = try await calls(hangupWire).hangup(
			voiceSessionID: "vs-1", reason: .userHangup, inputAudioSeconds: -3, outputAudioSeconds: 7)
		#expect(conversationID == "c-9")
		let seen = try #require(hangupWire.seen.first)
		#expect(seen.path == "/api/voice-sessions/vs-1/hangup")
		let body = try #require(try JSONSerialization.jsonObject(with: seen.body) as? [String: Any])
		#expect(body["reason"] as? String == "user_hangup")
		#expect(body["input_audio_seconds"] as? Int == 0)
		#expect(body["output_audio_seconds"] as? Int == 7)
	}

	@Test("status codes map to the failure the call screen reacts to")
	func failures() async {
		#expect(await failure(404) == .unavailable)
		#expect(await failure(400) == .notAnAgent)
		#expect(await failure(409) == .alreadyInCall)
		#expect(
			await failure(500, json: #"{"error":{"code":"INTERNAL_ERROR","message":"Vendor connect failed (status 500)"}}"#)
				== .server("Vendor connect failed (status 500)"))
		#expect(await failure(502, json: "{}") == .server("Voice call failed (502)."))
	}

	@Test("a rate limit on the offer carries the wait the server asked for")
	func rateLimited() async {
		let wire = VoiceWire(
			status: 429,
			json: #"{"error":{"code":"RATE_LIMITED","message":"x"},"retry_after_seconds":120}"#)
		do {
			_ = try await calls(wire).offer(voiceSessionID: "vs-1", sdp: "offer", noiseReduction: nil)
			Issue.record("expected the offer to fail")
		} catch {
			#expect(error as? VoiceCallFailure == .rateLimited(retryAfterSeconds: 120))
		}
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
