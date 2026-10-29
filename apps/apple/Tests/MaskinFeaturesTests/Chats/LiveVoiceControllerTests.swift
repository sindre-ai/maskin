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
	var onText: (@MainActor (String, Bool) -> Void)?
	var resets = 0
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
			resetTranscript: { [self] in resets += 1 },
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

	func hear(_ text: String, final: Bool = false) { onText?(text, final) }
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
	/// Most tests start the call in silence; the greeting has its own tests.
	private func make(pace: LiveCallPace = .quick, greeting: String? = nil) -> (LiveVoiceController, FakeRoom) {
		let room = FakeRoom()
		// A long beat: the tests tick by hand; a private defaults suite so the stored pace is untouched.
		let defaults = UserDefaults(suiteName: "live-voice-\(UUID().uuidString)")!
		return (
			LiveVoiceController(
				ports: room.ports, tickInterval: .seconds(3600), defaults: defaults, pace: pace,
				greeting: greeting), room
		)
	}

	@Test("beginning starts the microphone")
	func begins() async {
		let (live, room) = make()
		live.begin(existing: [])
		await settle()
		#expect(live.isActive && live.phase == .listening)
		#expect(room.starts == 1 && room.listening)
	}

	@Test("the call opens with a spoken greeting that is never sent to the chat")
	func greets() async {
		let (live, room) = make(greeting: LiveVoiceController.defaultGreeting)
		live.begin(existing: [])
		await settle()
		#expect(room.spoken.map(\.text) == [LiveVoiceController.defaultGreeting])
		#expect(room.sent.isEmpty && live.turns.isEmpty)
		#expect(live.phase == .speaking)
		// The reader finishing hands the turn back to you.
		room.speakingID = nil
		live.tick()
		#expect(live.phase == .listening)
		#expect(room.spoken.count == 1)
	}

	@Test("the greeting is also spoken when the call starts muted")
	func greetsWhenMuted() async {
		let (live, room) = make(greeting: LiveVoiceController.defaultGreeting)
		live.toggleMute()
		live.begin(existing: [])
		await settle()
		#expect(live.isMuted)
		#expect(room.spoken.count == 1)
	}

	@Test("talking over the greeting cuts it off and becomes your turn")
	func bargeInOnGreeting() async {
		let (live, room) = make(greeting: LiveVoiceController.defaultGreeting)
		live.begin(existing: [])
		await settle()
		room.hear("what is blocked right now")
		#expect(live.phase == .listening)
		#expect(room.stoppedSpeaking == 1)
		room.advance(3)
		live.tick()
		#expect(room.sent == ["what is blocked right now"])
	}

	@Test("a spoken sentence is sent after the pause, and the microphone stays on")
	func sendsWhatYouSay() async {
		let (live, room) = make()
		live.begin(existing: [])
		await settle()
		room.hear("what is blocked right now")
		#expect(live.transcript == "what is blocked right now")
		room.advance(3)
		live.tick()
		#expect(room.sent == ["what is blocked right now"])
		#expect(room.stopsListening == 0 && room.listening)
		#expect(room.resets >= 1)
		#expect(live.phase == .thinking)
	}

	@Test("what you said and what the agent replied are kept as the call's turns")
	func keepsTurns() async {
		let (live, room) = make()
		live.agentName = "Relay"
		live.begin(existing: [])
		await settle()
		room.hear("summarise the pipeline please")
		room.advance(3)
		live.tick()
		live.messagesChanged([message(2, "Three bets are blocked.")])
		#expect(
			live.turns == [
				LiveMeetingTurn(speaker: "You", text: "summarise the pipeline please", isYou: true),
				LiveMeetingTurn(speaker: "Relay", text: "Three bets are blocked.", isYou: false),
			])
	}

	@Test("the reply is read aloud, then it listens again")
	func fullTurn() async {
		let (live, room) = make()
		live.begin(existing: [message(1, agent: false, "earlier")])
		await settle()
		room.hear("summarise the pipeline please")
		room.advance(3)
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
		#expect(room.starts == 1 && room.listening)
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
		room.advance(3)
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
		room.advance(3)
		live.tick()
		live.messagesChanged([message(1, "Once upon a time…")])
		live.interrupt()
		await settle()
		#expect(room.stoppedSpeaking == 1 && room.speakingID == nil)
		#expect(live.phase == .listening && room.listening)
	}

	@Test("talking over the agent cuts it off")
	func bargeIn() async {
		let (live, room) = make()
		live.begin(existing: [])
		await settle()
		room.hear("tell me a long story")
		room.advance(3)
		live.tick()
		live.messagesChanged([message(1, "Once upon a time in a land far away.")])
		room.hear("wait stop there")
		#expect(room.stoppedSpeaking == 1 && room.speakingID == nil)
		#expect(live.phase == .listening && live.transcript == "wait stop there")
	}

	@Test("ending sends what was heard but not yet sent")
	func endSavesPending() async {
		let (live, room) = make()
		live.begin(existing: [])
		await settle()
		room.hear("remind me about the offsite")
		live.end()
		#expect(room.sent == ["remind me about the offsite"])
		#expect(live.turns.last?.isYou == true)
	}

	@Test("an interruption pauses the call and saves what was said; it resumes when audio returns")
	func interruption() async {
		let (live, room) = make()
		live.begin(existing: [])
		await settle()
		room.hear("one more thing before")
		live.interruptionBegan()
		#expect(live.isInterrupted && !room.listening)
		#expect(room.sent == ["one more thing before"])
		live.tick()
		await settle()
		#expect(!room.listening)
		live.interruptionEnded(shouldResume: true)
		await settle()
		#expect(live.isActive && room.listening && !live.isInterrupted)
	}

	@Test("an interruption that does not hand the audio back ends the call and says so")
	func interruptionEnds() async {
		let (live, room) = make()
		live.begin(existing: [])
		await settle()
		live.interruptionBegan()
		live.interruptionEnded(shouldResume: false)
		#expect(!live.isActive)
		#expect(live.failure?.contains("interrupted") == true)
		_ = room
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

	@Test("a recogniser that keeps dying ends the conversation instead of restarting forever")
	func restartLoopEnds() async {
		let (live, room) = make()
		live.begin(existing: [])
		await settle()
		for _ in 0..<6 {
			room.listening = false
			room.advance(1)
			live.tick()
			await settle()
		}
		#expect(!live.isActive)
		#expect(live.failure?.contains("keep listening") == true)
	}

	@Test("an occasional restart is fine")
	func occasionalRestart() async {
		let (live, room) = make()
		live.begin(existing: [])
		await settle()
		for _ in 0..<3 {
			room.listening = false
			room.advance(20)
			live.tick()
			await settle()
		}
		#expect(live.isActive && room.listening)
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

	// MARK: Paced reading

	private static let reply =
		"One is here. Two is here. Three is here. Four is here. Five is here. Six is here."

	/// Gets the call to the point where the agent has begun reading `reply` in beats.
	private func startReading(_ live: LiveVoiceController, _ room: FakeRoom) async {
		live.begin(existing: [])
		await settle()
		room.hear("tell me the news please")
		room.advance(3)
		live.tick()
		live.messagesChanged([message(1, Self.reply)])
	}

	@Test("a long reply is read in beats with a listening break between them")
	func readsInBeats() async {
		let (live, room) = make(pace: .relaxed)
		await startReading(live, room)
		#expect(room.spoken.map(\.text) == ["One is here. Two is here."])
		#expect(live.phase == .speaking && !live.isYourTurn)
		room.speakingID = nil
		live.tick()
		#expect(live.isYourTurn)
		#expect(room.spoken.count == 1)
		room.advance(1.9)
		live.tick()
		#expect(room.spoken.map(\.text).last == "Three is here. Four is here.")
		#expect(!live.isYourTurn)
	}

	@Test("saying yes in a break carries straight on")
	func yesContinues() async {
		let (live, room) = make(pace: .relaxed)
		await startReading(live, room)
		room.speakingID = nil
		live.tick()
		room.hear("yes")
		room.advance(0.6)
		live.tick()
		#expect(room.spoken.count == 2)
	}

	@Test("speaking in a break stops the reading and the words become your turn")
	func takingOver() async {
		let (live, room) = make(pace: .relaxed)
		await startReading(live, room)
		room.speakingID = nil
		live.tick()
		room.hear("what about billing")
		#expect(live.phase == .listening && live.transcript == "what about billing")
		room.advance(3)
		live.tick()
		#expect(room.sent.last == "what about billing")
		#expect(room.spoken.count == 1)
	}

	@Test("go on after being cut off picks the reading up again")
	func goOnResumes() async {
		let (live, room) = make(pace: .relaxed)
		await startReading(live, room)
		room.hear("wait stop there now")  // talks over the first beat
		#expect(live.phase == .listening)
		room.advance(1)
		live.tick()
		// Not yet sent; the person says "go on" instead of a question.
		room.hear("go on")
		room.advance(0.6)
		live.tick()
		#expect(live.phase == .speaking)
		#expect(room.spoken.last?.text == "One is here. Two is here.")
	}

	@Test("a check-in is spoken but never sent or kept as a turn")
	func checkInIsLocal() async {
		let (live, room) = make(pace: .relaxed)
		live.begin(existing: [])
		await settle()
		let long = (1...12).map { "Sentence number \($0) is here." }.joined(separator: " ")
		room.hear("tell me the news please")
		room.advance(3)
		live.tick()
		live.messagesChanged([message(1, long)])
		for _ in 0..<12 where live.phase == .speaking {
			room.speakingID = nil
			live.tick()
			room.advance(4)
			live.tick()
		}
		#expect(room.spoken.contains { $0.id.contains("checkin") })
		#expect(room.sent == ["tell me the news please"])
		#expect(live.turns.allSatisfy { !$0.text.hasPrefix("Want me") })
	}

	@Test("quick reads the whole reply at once")
	func quickIsContinuous() async {
		let (live, room) = make(pace: .quick)
		await startReading(live, room)
		#expect(room.spoken.count == 1 && room.spoken[0].text.contains("Six is here."))
	}

	@Test("changing the pace is remembered")
	func paceIsRemembered() async {
		let room = FakeRoom()
		let defaults = UserDefaults(suiteName: "live-voice-\(UUID().uuidString)")!
		let live = LiveVoiceController(ports: room.ports, defaults: defaults)
		#expect(live.pace == .relaxed)
		live.pace = .normal
		#expect(LiveCallPace.stored(defaults) == .normal)
		let again = LiveVoiceController(ports: room.ports, defaults: defaults)
		#expect(again.pace == .normal)
	}
}
