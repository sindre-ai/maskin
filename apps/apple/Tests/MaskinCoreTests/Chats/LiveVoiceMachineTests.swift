import Foundation
import Testing

@testable import MaskinCore

@Suite("LiveVoiceMachine") struct LiveVoiceMachineTests {
	private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
	private func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

	@Test("it starts by listening")
	func begins() {
		var m = LiveVoiceMachine()
		#expect(m.begin() == [.startListening])
		#expect(m.phase == .listening)
	}

	@Test("what you say is sent once you have been quiet for the silence window, and listening stops")
	func sendsAfterAPause() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("what changed", at: at(0))
		#expect(m.tick(at: at(1.0)).isEmpty)
		_ = m.heard("what changed since Friday", at: at(1.2))
		// The pause is measured from the last change in the words.
		#expect(m.tick(at: at(2.0)).isEmpty)
		#expect(m.tick(at: at(2.8)) == [.stopListening, .send("what changed since Friday")])
		#expect(m.phase == .thinking)
		#expect(m.transcript.isEmpty)
	}

	@Test("a repeated identical transcript does not restart the pause")
	func repeatsDoNotCount() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("send this now", at: at(0))
		_ = m.heard("send this now", at: at(1.4))
		#expect(m.tick(at: at(1.6)) == [.stopListening, .send("send this now")])
	}

	@Test("a cough or a single word is not a message and is forgotten after a few seconds")
	func ignoresFragments() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("um", at: at(0))
		#expect(m.tick(at: at(2)).isEmpty)
		#expect(m.transcript == "um")
		#expect(m.tick(at: at(4.5)).isEmpty)
		#expect(m.transcript.isEmpty)
	}

	@Test("the reply is read aloud, more replies queue behind it, and listening resumes after")
	func replyThenListenAgain() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("what is blocked", at: at(0))
		_ = m.tick(at: at(2))
		#expect(m.replyArrived(messageID: "m1") == [.speak(messageID: "m1")])
		#expect(m.phase == .speaking)
		#expect(m.replyArrived(messageID: "m2") == [.speak(messageID: "m2")])
		#expect(m.speechFinished() == [.startListening])
		#expect(m.phase == .listening)
	}

	@Test("an agent message while you are only listening (a reply to something typed) is left alone")
	func ignoresUnrelatedReplies() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		#expect(m.replyArrived(messageID: "x").isEmpty)
		#expect(m.phase == .listening)
	}

	@Test("an errored turn goes back to listening instead of speaking")
	func failedReply() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("do the thing please", at: at(0))
		_ = m.tick(at: at(2))
		#expect(m.replyFailed() == [.startListening])
		#expect(m.phase == .listening)
		#expect(m.replyFailed().isEmpty)
	}

	@Test("interrupting stops the voice and listens at once")
	func interrupts() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("tell me more please", at: at(0))
		_ = m.tick(at: at(2))
		_ = m.replyArrived(messageID: "m1")
		#expect(m.interrupt() == [.stopSpeaking, .startListening])
		#expect(m.phase == .listening)
		#expect(m.interrupt().isEmpty)
	}

	@Test("no reply for a long time puts it back to listening")
	func replyTimeout() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("are you there", at: at(0))
		_ = m.tick(at: at(2))
		#expect(m.tick(at: at(60)).isEmpty)
		#expect(m.tick(at: at(95)) == [.startListening])
		#expect(m.phase == .listening)
	}

	@Test("muting stops listening and drops what was heard; unmuting listens again")
	func mute() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("half a sentence", at: at(0))
		#expect(m.setMuted(true) == [.stopListening])
		#expect(m.transcript.isEmpty)
		#expect(m.heard("ignored while muted", at: at(1)).isEmpty)
		#expect(m.tick(at: at(5)).isEmpty)
		#expect(m.setMuted(true).isEmpty)
		#expect(m.setMuted(false) == [.startListening])
	}

	@Test("muted while the agent talks: the next listening phase stays off until unmuted")
	func muteDuringSpeech() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("say something long", at: at(0))
		_ = m.tick(at: at(2))
		_ = m.replyArrived(messageID: "m1")
		#expect(m.setMuted(true).isEmpty)
		#expect(m.speechFinished().isEmpty)
		#expect(m.setMuted(false) == [.startListening])
	}

	@Test("ending stops everything")
	func ends() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		#expect(m.end() == [.stopListening, .stopSpeaking])
	}
}
