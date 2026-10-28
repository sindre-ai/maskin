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
	private(set) var createdFrom: [String?] = []
	private(set) var offers: [String] = []
	private(set) var hangups: [Hangup] = []

	func failCreate(_ failure: VoiceCallFailure) { createFailure = failure }
	func failOffer(_ failure: VoiceCallFailure) { offerFailure = failure }

	func create(agentActorID: String, conversationID: String?) async throws -> String {
		if let createFailure { throw createFailure }
		created.append(agentActorID)
		createdFrom.append(conversationID)
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
		conversationID: String? = nil, reconnectWindow: Duration = .seconds(3600)
	) -> (RealtimeVoiceCall, FakeCalls, FakeTransport) {
		let call = RealtimeVoiceCall(
			agentID: "agent-1", agentName: "Chief", conversationID: conversationID, calls: calls,
			makeTransport: { transport },
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

	@Test("a call started from a chat reserves the call with that chat's id")
	func sendsTheChat() async {
		let (call, calls, _) = make(conversationID: "chat-1")
		call.begin(existing: [])
		await settle()
		#expect(await calls.createdFrom == ["chat-1"])
	}

	@Test("a call that isn't started from a chat sends no chat id")
	func sendsNoChat() async {
		let (call, calls, _) = make()
		call.begin(existing: [])
		await settle()
		#expect(await calls.createdFrom == [nil])
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

	@Test("the agent is asked to greet once, also when muted and after an ICE restart")
	func greetsOnce() async {
		let (call, _, transport) = make()
		call.begin(existing: [])
		call.toggleMute()
		await settle()
		transport.receive("session.created")
		#expect(transport.sent == [RealtimeCallMachine.greetingRequest])
		transport.onConnection?(.failed)
		transport.onConnection?(.connected)
		transport.receive("session.created")
		#expect(transport.iceRestarts == 1)
		#expect(transport.sent == [RealtimeCallMachine.greetingRequest])
	}

	private func chatMessage(_ id: Int, agent: Bool = false, _ text: String, name: String = "Me") -> ChatMessage {
		.confirmed(
			serverID: id, conversationID: "chat-1", actorID: agent ? "agent-1" : "me", actorName: agent ? "Chief" : name,
			author: agent ? .agent : .human, content: text)
	}

	/// The text of each conversation item the call has sent, apart from the greeting.
	private func handedOn(_ transport: FakeTransport) -> [String] {
		transport.sent.compactMap { json in
			guard let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
				object["type"] as? String == "conversation.item.create",
				let item = object["item"] as? [String: Any], item["role"] as? String == "user",
				let content = (item["content"] as? [[String: Any]])?.first
			else { return nil }
			return content["text"] as? String
		}
	}

	@Test("a line typed in the chat during the call is handed to the agent, once, and an agent message is not")
	func forwardsTypedMessages() async {
		let (call, _, transport) = make(conversationID: "chat-1")
		let earlier = chatMessage(1, "from before the call")
		call.begin(existing: [earlier])
		await settle()
		transport.receive("session.created")
		let typed = chatMessage(2, "The meeting moved to Thursday")
		let reply = chatMessage(3, agent: true, "Noted.")
		call.messagesChanged([earlier, typed, reply])
		call.messagesChanged([earlier, typed, reply])
		call.messagesChanged([earlier, typed, reply, chatMessage(4, "Also Anna is joining", name: "Anna")])
		#expect(
			handedOn(transport) == [
				"Me typed in the chat during this call: The meeting moved to Thursday",
				"Anna typed in the chat during this call: Also Anna is joining",
			])
		// Handing a line over does not ask the agent to talk over the person.
		#expect(transport.sent.filter { $0.contains("response.create") } == [RealtimeCallMachine.greetingRequest])
	}

	@Test("the person's own spoken lines, saved into the chat during the call, are not fed back")
	func skipsSpokenLines() async {
		let (call, _, transport) = make()
		call.begin(existing: [])
		await settle()
		transport.receive("session.created")
		let spoken = ChatMessage.confirmed(
			serverID: 1, conversationID: "chat-1", actorID: "me", actorName: "Me", author: .human,
			content: "what I just said aloud", metadata: .object(["source": .string("voice")]))
		let typed = chatMessage(2, "typed after")
		call.messagesChanged([spoken])
		call.messagesChanged([spoken, typed])
		#expect(handedOn(transport) == ["Me typed in the chat during this call: typed after"])
	}

	@Test("telling the agent what was chosen adds the note and asks it to carry on")
	func tellsTheAgent() async {
		let (call, _, transport) = make()
		call.begin(existing: [])
		await settle()
		transport.receive("session.created")
		transport.sent.removeAll()
		call.tell("I chose: Ship on: Ship Friday?")
		#expect(handedOn(transport) == ["I chose: Ship on: Ship Friday?"])
		#expect(transport.sent.last == RealtimeCallMachine.responseRequest)
	}

	@Test("while the agent is speaking only the note is added, not a second response")
	func tellsWithoutTalkingOver() async {
		let (call, _, transport) = make()
		call.begin(existing: [])
		await settle()
		transport.receive("session.created")
		transport.receive("output_audio_buffer.started")
		#expect(call.phase == .speaking)
		transport.sent.removeAll()
		call.tell("I chose: Hold on: Ship?")
		#expect(handedOn(transport) == ["I chose: Hold on: Ship?"])
		#expect(!transport.sent.contains(RealtimeCallMachine.responseRequest))
	}

	@Test("a note told before the connection is open waits for it")
	func tellWaitsForTheChannel() async {
		let (call, _, transport) = make()
		call.begin(existing: [])
		call.tell("I chose: Ship on: Ship?")
		await settle()
		#expect(handedOn(transport).isEmpty)
		transport.receive("session.created")
		#expect(handedOn(transport) == ["I chose: Ship on: Ship?"])
	}

	@Test("a line typed before the connection is open waits for it")
	func queuesUntilOpen() async {
		let (call, _, transport) = make()
		call.begin(existing: [])
		call.messagesChanged([chatMessage(1, "typed early")])
		await settle()
		#expect(handedOn(transport).isEmpty)
		transport.receive("session.created")
		#expect(handedOn(transport) == ["Me typed in the chat during this call: typed early"])
	}

	@Test("a line that isn't sent yet is handed over when it is, and a failed one never is")
	func waitsForTheSend() async {
		let (call, _, transport) = make()
		call.begin(existing: [])
		await settle()
		transport.receive("session.created")
		var line = chatMessage(1, "typed offline")
		line.status = .waiting("Offline")
		var broken = chatMessage(2, "refused")
		broken.status = .failed("Refused")
		call.messagesChanged([line, broken])
		#expect(handedOn(transport).isEmpty)
		line.status = .sent
		call.messagesChanged([line, broken])
		#expect(handedOn(transport) == ["Me typed in the chat during this call: typed offline"])
	}

	@Test("nothing is handed on once the call has ended")
	func silentAfterHangup() async {
		let (call, _, transport) = make()
		call.begin(existing: [])
		await settle()
		transport.receive("session.created")
		call.end()
		call.messagesChanged([chatMessage(1, "the saved transcript")])
		#expect(handedOn(transport).isEmpty)
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
