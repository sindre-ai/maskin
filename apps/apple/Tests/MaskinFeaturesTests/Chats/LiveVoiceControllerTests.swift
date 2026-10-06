import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

/// Stands in for the microphone and speaker; the test plays the part of the room.
@MainActor
private final class FakeRoom {
	var clock = Date(timeIntervalSince1970: 1_800_000_000)
	var listening = false
	var speakingID: String?
	var onText: (@MainActor (String) -> Void)?
	var startFailure: String?
	var starts = 0
	var stopsListening = 0
	var sent: [String] = []
	var spoken: [(id: String, text: String)] = []
	var stoppedSpeaking = 0

	var ports: LiveVoiceController.Ports {
		LiveVoiceController.Ports(
			startListening: { [self] onText in
				starts += 1
				if let startFailure { return startFailure }
				self.onText = onText
				listening = true
				return nil
			},
			stopListening: { [self] in
				stopsListening += 1
				listening = false
			},
			isListening: { [self] in listening },
			speak: { [self] id, text in
				spoken.append((id, text))
				speakingID = id
			},
			stopSpeaking: { [self] in
				stoppedSpeaking += 1
				speakingID = nil
			},
			isSpeaking: { [self] in speakingID != nil },
			send: { [self] text in sent.append(text) },
			now: { [self] in clock }
		)
	}

	func hear(_ text: String) { onText?(text) }
	func advance(_ seconds: TimeInterval) { clock = clock.addingTimeInterval(seconds) }
}

private func message(_ id: Int, agent: Bool = true, _ text: String = "Here you go.", error: Bool = false) -> ChatMessage {
	.confirmed(
		serverID: id, conversationID: "c", actorID: agent ? "relay" : "me", actorName: agent ? "Relay" : "Me",
		author: agent ? .agent : .human, content: text,
		metadata: error ? .object(["final_output": .object(["is_error": .bool(true)])]) : nil)
}

/// Lets the controller's `Task`s run.
@MainActor
private func settle() async { for _ in 0..<20 { await Task.yield() } }

@MainActor
@Suite("LiveVoiceController") struct LiveVoiceControllerTests {
	private func make() -> (LiveVoiceController, FakeRoom) {
		let room = FakeRoom()
		// A long beat: the tests tick by hand.
		return (LiveVoiceController(ports: room.ports, tickInterval: .seconds(3600)), room)
	}

	@Test("beginning starts the microphone")
	func begins() async {
		let (live, room) = make()
		live.begin(existing: [])
		await settle()
		#expect(live.isActive && live.phase == .listening)
		#expect(room.starts == 1 && room.listening)
	}

	@Test("a spoken sentence is sent after the pause, and the microphone is turned off for the reply")
	func sendsWhatYouSay() async {
		let (live, room) = make()
		live.begin(existing: [])
		await settle()
		room.hear("what is blocked right now")
		#expect(live.transcript == "what is blocked right now")
		room.advance(2)
		live.tick()
		#expect(room.sent == ["what is blocked right now"])
		#expect(room.stopsListening == 1 && !room.listening)
		#expect(live.phase == .thinking)
	}

	@Test("the reply is read aloud, then it listens again")
	func fullTurn() async {
		let (live, room) = make()
		live.begin(existing: [message(1, agent: false, "earlier")])
		await settle()
		room.hear("summarise the pipeline please")
		room.advance(2)
		live.tick()
		live.messagesChanged([message(1, agent: false, "earlier"), message(2, "Three bets are blocked.")])
		#expect(room.spoken.map(\.text) == ["Three bets are blocked."])
		#expect(live.phase == .speaking)
		// Still reading: nothing changes.
		live.tick()
		#expect(live.phase == .speaking)
		room.speakingID = nil
		live.tick()
		await settle()
		#expect(live.phase == .listening)
		#expect(room.starts == 2)
	}

	@Test("messages that were already in the thread are never read")
	func ignoresHistory() async {
		let (live, room) = make()
		let old = message(1, "An old agent message")
		live.begin(existing: [old])
		await settle()
		live.messagesChanged([old])
		#expect(room.spoken.isEmpty)
	}

	@Test("an errored reply is not read and listening resumes")
	func errorReply() async {
		let (live, room) = make()
		live.begin(existing: [])
		await settle()
		room.hear("do the thing for me")
		room.advance(2)
		live.tick()
		live.messagesChanged([message(1, "The model API timed out.", error: true)])
		await settle()
		#expect(room.spoken.isEmpty)
		#expect(live.phase == .listening)
	}

	@Test("tapping to interrupt silences the agent and listens")
	func interrupts() async {
		let (live, room) = make()
		live.begin(existing: [])
		await settle()
		room.hear("tell me a long story")
		room.advance(2)
		live.tick()
		live.messagesChanged([message(1, "Once upon a time…")])
		live.interrupt()
		await settle()
		#expect(room.stoppedSpeaking == 1 && room.speakingID == nil)
		#expect(live.phase == .listening && room.listening)
	}

	@Test("muting turns the microphone off and unmuting turns it on")
	func mute() async {
		let (live, room) = make()
		live.begin(existing: [])
		await settle()
		live.toggleMute()
		#expect(live.isMuted && !room.listening)
		live.tick()
		await settle()
		#expect(!room.listening)  // a muted microphone is not restarted
		live.toggleMute()
		await settle()
		#expect(!live.isMuted && room.listening)
	}

	@Test("a recogniser that stops by itself is started again")
	func restartsRecogniser() async {
		let (live, room) = make()
		live.begin(existing: [])
		await settle()
		room.listening = false
		live.tick()
		await settle()
		#expect(room.starts == 2 && room.listening)
	}

	@Test("if the microphone can't start the conversation ends and says why")
	func startFailure() async {
		let (live, room) = make()
		room.startFailure = "Allow Microphone access in Settings to dictate."
		live.begin(existing: [])
		await settle()
		#expect(!live.isActive)
		#expect(live.failure == "Allow Microphone access in Settings to dictate.")
	}

	@Test("ending stops the microphone and the voice")
	func ends() async {
		let (live, room) = make()
		live.begin(existing: [])
		await settle()
		live.end()
		#expect(!live.isActive && !room.listening)
		#expect(room.stoppedSpeaking == 1)
		live.messagesChanged([message(9, "ignored after end")])
		#expect(room.spoken.isEmpty)
	}
}
