import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

/// Stands in for the WebRTC connection; the test plays the part of the OpenAI edge.
@MainActor
private final class FakeTransport: RealtimeTransport {
	var offerFailure: Error?
	var onEvent: (@MainActor @Sendable (Data) -> Void)?
	var onConnection: (@MainActor @Sendable (RealtimeConnectionState) -> Void)?
	var accepted: [String] = []
	var sent: [String] = []
	var micEnabled: [Bool] = []
	var iceRestarts = 0
	var closed = 0

	func makeOffer(
		onEvent: @escaping @MainActor @Sendable (Data) -> Void,
		onConnection: @escaping @MainActor @Sendable (RealtimeConnectionState) -> Void
	) async throws -> String {
		if let offerFailure { throw offerFailure }
		self.onEvent = onEvent
		self.onConnection = onConnection
		return "offer-sdp"
	}
	func accept(answer: String) async throws { accepted.append(answer) }
	func send(_ json: String) { sent.append(json) }
	func setMicEnabled(_ enabled: Bool) { micEnabled.append(enabled) }
	func restartIce() { iceRestarts += 1 }
	func close() { closed += 1 }

	func receive(_ type: String) { onEvent?(Data(#"{"type":"\#(type)"}"#.utf8)) }
}

private actor FakeCalls: VoiceCalling {
	struct Hangup: Equatable {
		var id: String
		var reason: VoiceCallEndReason
	}

	var createFailure: VoiceCallFailure?
	var offerFailure: VoiceCallFailure?
	var toolsAvailable = true
	private(set) var created: [String] = []
	private(set) var offers: [String] = []
	private(set) var hangups: [Hangup] = []

	func failCreate(_ failure: VoiceCallFailure) { createFailure = failure }
	func failOffer(_ failure: VoiceCallFailure) { offerFailure = failure }

	func create(agentActorID: String) async throws -> String {
		if let createFailure { throw createFailure }
		created.append(agentActorID)
		return "vs-1"
	}

	func offer(voiceSessionID: String, sdp: String) async throws -> VoiceCallAnswer {
		if let offerFailure { throw offerFailure }
		offers.append(sdp)
		return VoiceCallAnswer(sdp: "answer-sdp", toolsAvailable: toolsAvailable, persistTranscripts: true)
	}

	func hangup(
		voiceSessionID: String, reason: VoiceCallEndReason, inputAudioSeconds: Int,
		outputAudioSeconds: Int
	) async throws -> String? {
		hangups.append(Hangup(id: voiceSessionID, reason: reason))
		return nil
	}
}

@MainActor
@Suite("RealtimeVoiceCall") struct RealtimeVoiceCallTests {
	private func make(
		calls: FakeCalls = FakeCalls(), transport: FakeTransport = FakeTransport(),
		reconnectWindow: Duration = .seconds(3600)
	) -> (RealtimeVoiceCall, FakeCalls, FakeTransport) {
		let call = RealtimeVoiceCall(
			agentID: "agent-1", agentName: "Chief", calls: calls, makeTransport: { transport },
			reconnectWindow: reconnectWindow)
		return (call, calls, transport)
	}

	/// Let the start-up task run to its end.
	private func settle() async {
		for _ in 0..<20 { await Task.yield() }
		try? await Task.sleep(for: .milliseconds(20))
	}

	@Test("it reserves the call, posts the offer and applies the answer")
	func connects() async {
		let (call, calls, transport) = make()
		call.begin(existing: [])
		await settle()
		#expect(await calls.created == ["agent-1"])
		#expect(await calls.offers == ["offer-sdp"])
		#expect(transport.accepted == ["answer-sdp"])
		#expect(call.failure == nil)
	}

	@Test("each finished line of the call is handed on, yours and the agent's, but not tool calls")
	func handsOnFinishedLines() async {
		let (call, _, transport) = make()
		var lines: [String] = []
		call.onLine = { isYou, text in lines.append("\(isYou ? "you" : "agent"): \(text)") }
		call.begin(existing: [])
		await settle()
		func send(_ json: String) { transport.onEvent?(Data(json.utf8)) }
		send(#"{"type":"conversation.item.input_audio_transcription.completed","transcript":"What is blocked?"}"#)
		send(#"{"type":"response.function_call_arguments.done","call_id":"c1","name":"list_objects","arguments":"{}"}"#)
		send(#"{"type":"response.output_audio_transcript.done","transcript":"Three bets."}"#)
		#expect(lines == ["you: What is blocked?", "agent: Three bets."])
	}

	@Test("events from the call drive the phase")
	func phases() async {
		let (call, _, transport) = make()
		call.begin(existing: [])
		await settle()
		transport.receive("input_audio_buffer.speech_stopped")
		#expect(call.phase == .thinking)
		transport.receive("output_audio_buffer.started")
		#expect(call.phase == .speaking)
		transport.receive("output_audio_buffer.stopped")
		#expect(call.phase == .listening)
	}

	@Test("when voice calls are off for this person it falls back, and reserves nothing")
	func fallsBack() async {
		let calls = FakeCalls()
		await calls.failCreate(.unavailable)
		let (call, _, _) = make(calls: calls)
		var fellBack = 0
		call.onFallBack = { fellBack += 1 }
		call.begin(existing: [])
		await settle()
		#expect(fellBack == 1)
		#expect(call.failure == nil)
		#expect(await calls.hangups.isEmpty)
	}

	@Test("with no WebRTC built in it falls back")
	func noTransport() async {
		let call = RealtimeVoiceCall(
			agentID: "agent-1", agentName: "Chief", calls: FakeCalls(), makeTransport: { nil })
		var fellBack = 0
		call.onFallBack = { fellBack += 1 }
		call.begin(existing: [])
		await settle()
		#expect(fellBack == 1)
	}

	@Test("a refused microphone says so and gives the reserved call back")
	func microphoneDenied() async {
		let transport = FakeTransport()
		transport.offerFailure = RealtimeTransportError.microphoneDenied
		let (call, calls, _) = make(transport: transport)
		call.begin(existing: [])
		await settle()
		#expect(call.failure?.contains("Microphone") == true)
		#expect(await calls.hangups == [.init(id: "vs-1", reason: .networkError)])
	}

	@Test("a refused offer ends the call with the reason and gives the slot back")
	func offerRefused() async {
		let calls = FakeCalls()
		await calls.failOffer(.rateLimited(retryAfterSeconds: 30))
		let (call, _, transport) = make(calls: calls)
		call.begin(existing: [])
		await settle()
		#expect(call.failure != nil)
		#expect(transport.closed >= 1)
		#expect(await calls.hangups == [.init(id: "vs-1", reason: .networkError)])
	}

	@Test("hanging up tells the server once and lets go of the connection")
	func hangsUp() async {
		let (call, calls, transport) = make()
		call.begin(existing: [])
		await settle()
		call.end()
		call.end()
		await settle()
		#expect(await calls.hangups == [.init(id: "vs-1", reason: .userHangup)])
		#expect(transport.closed == 1)
	}

	@Test("muting switches the microphone track")
	func mutes() async {
		let (call, _, transport) = make()
		call.begin(existing: [])
		await settle()
		call.toggleMute()
		#expect(call.isMuted)
		#expect(transport.micEnabled.last == false)
		call.toggleMute()
		#expect(transport.micEnabled.last == true)
	}

	@Test("tapping to interrupt cancels the response")
	func interrupts() async {
		let (call, _, transport) = make()
		call.begin(existing: [])
		await settle()
		transport.receive("output_audio_buffer.started")
		call.interrupt()
		#expect(transport.sent.contains(#"{"type":"response.cancel"}"#))
		#expect(call.phase == .listening)
	}

	@Test("a dropped connection that does not come back ends the call as a network error")
	func dropped() async {
		let (call, calls, transport) = make(reconnectWindow: .milliseconds(30))
		call.begin(existing: [])
		await settle()
		transport.onConnection?(.failed)
		#expect(transport.iceRestarts == 1)
		// Wait for the call to end instead of guessing how long a loaded runner needs.
		var polls = 0
		while polls < 200 {
			let hungUp = await !calls.hangups.isEmpty
			if call.failure != nil && hungUp { break }
			try? await Task.sleep(for: .milliseconds(10))
			polls += 1
		}
		#expect(call.failure != nil)
		#expect(await calls.hangups == [.init(id: "vs-1", reason: .networkError)])
	}

	@Test("a connection that comes back in time keeps the call")
	func recovers() async {
		let (call, calls, transport) = make(reconnectWindow: .milliseconds(60))
		call.begin(existing: [])
		await settle()
		transport.onConnection?(.disconnected)
		transport.onConnection?(.connected)
		try? await Task.sleep(for: .milliseconds(150))
		#expect(call.failure == nil)
		#expect(await calls.hangups.isEmpty)
	}
}
