import Foundation
import Testing

@testable import MaskinCore

@Suite("LiveVoiceMachine") struct LiveVoiceMachineTests {
	private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
	private func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

	@Test("it starts by listening")
	func begins() {
		var m = LiveVoiceMachine()
		#expect(m.begin() == [.resetTranscript, .startListening])
		#expect(m.phase == .listening)
	}

	@Test("what you say is sent once you have been quiet for the silence window, and the microphone stays open")
	func sendsAfterAPause() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("what changed", at: at(0))
		#expect(m.tick(at: at(1.0)).isEmpty)
		_ = m.heard("what changed since Friday", at: at(1.2))
		// The pause is measured from the last change in the words.
		#expect(m.tick(at: at(3.0)).isEmpty)
		#expect(m.tick(at: at(3.7)) == [.resetTranscript, .send("what changed since Friday")])
		#expect(m.phase == .thinking)
		#expect(m.transcript.isEmpty)
	}

	@Test("a repeated identical transcript does not restart the pause")
	func repeatsDoNotCount() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("send this now", at: at(0))
		_ = m.heard("send this now", at: at(1.4))
		#expect(m.tick(at: at(2.0)).isEmpty)
		#expect(m.tick(at: at(2.5)) == [.resetTranscript, .send("send this now")])
	}

	@Test("a filler or a cough is not a message and is forgotten after a few seconds")
	func ignoresFragments() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("um", at: at(0))
		#expect(m.tick(at: at(3)).isEmpty)
		#expect(m.transcript == "um")
		#expect(m.tick(at: at(4.5)) == [.resetTranscript])
		#expect(m.transcript.isEmpty)
		#expect(m.pendingText == nil)
	}

	@Test("a single real word counts, after a slightly longer wait")
	func yesAndNoCount() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("Yes", at: at(0))
		#expect(m.tick(at: at(1.3)).isEmpty)
		#expect(m.tick(at: at(1.7)) == [.resetTranscript, .send("Yes")])
	}

	@Test("a thought that trails off is not sent mid-sentence (\"Can you tell me what…\")")
	func unfinishedThoughtWaits() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("Can you tell me what", at: at(0))
		#expect(m.tick(at: at(3.0)).isEmpty)
		#expect(m.tick(at: at(4.0)).isEmpty)
		// Still thinking; the rest arrives and is sent as one message.
		_ = m.heard("Can you tell me what some people are working on", at: at(4.2))
		#expect(m.tick(at: at(5.5)).isEmpty)
		#expect(m.tick(at: at(7.5)) == [.resetTranscript, .send("Can you tell me what some people are working on")])
	}

	@Test("a trailing preposition waits about three seconds")
	func prepositionWaits() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("what are people working on", at: at(0))
		#expect(m.tick(at: at(2.8)).isEmpty)
		#expect(m.tick(at: at(3.3)) == [.resetTranscript, .send("what are people working on")])
	}

	@Test("a finished sentence is sent after a shorter pause")
	func sentenceEndIsQuicker() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("What are the biggest blockers right now?", at: at(0))
		#expect(m.tick(at: at(1.0)).isEmpty)
		#expect(m.tick(at: at(1.4)) == [.resetTranscript, .send("What are the biggest blockers right now?")])
	}

	@Test("a comma means more is coming")
	func commaWaits() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("Send me the list,", at: at(0))
		#expect(m.tick(at: at(3.0)).isEmpty)
		#expect(m.tick(at: at(4.6)) == [.resetTranscript, .send("Send me the list,")])
	}

	@Test("send now does not wait for the pause")
	func sendNow() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		#expect(m.commitNow(at: at(0)).isEmpty)
		_ = m.heard("Can you tell me what", at: at(0))
		#expect(m.commitNow(at: at(0.2)) == [.resetTranscript, .send("Can you tell me what")])
		#expect(m.phase == .thinking && m.transcript.isEmpty)
	}

	@Test("the recogniser calling the utterance final sends it sooner")
	func finalSendsSooner() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("book it for Tuesday", at: at(0))
		_ = m.heard("book it for Tuesday", at: at(0.1), isFinal: true)
		#expect(m.tick(at: at(0.8)).isEmpty)
		#expect(m.tick(at: at(1.2)) == [.resetTranscript, .send("book it for Tuesday")])
	}

	@Test("more words after a final one wait for their own pause")
	func wordsAfterFinalWait() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("book it", at: at(0), isFinal: true)
		_ = m.heard("book it for Tuesday please", at: at(0.2))
		#expect(m.tick(at: at(1.0)).isEmpty)
		#expect(m.tick(at: at(2.8)) == [.resetTranscript, .send("book it for Tuesday please")])
	}

	@Test("you can keep talking while the agent works: it is sent as a follow-up and the wait restarts")
	func followUpWhileThinking() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("what is blocked", at: at(0))
		_ = m.tick(at: at(3))
		#expect(m.phase == .thinking)
		_ = m.heard("and who owns it?", at: at(3))
		#expect(m.tick(at: at(4.5)) == [.resetTranscript, .send("and who owns it?")])
		#expect(m.phase == .thinking)
	}

	@Test("talking over the agent cuts it off and keeps your words")
	func bargeIn() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("what is blocked", at: at(0))
		_ = m.tick(at: at(3))
		_ = m.replyArrived(messageID: "m1", text: "Three bets are blocked on review.")
		let cmds = m.heard("actually stop", at: at(5))
		#expect(cmds == [.stopSpeaking])
		#expect(m.phase == .listening)
		#expect(m.transcript == "actually stop")
		#expect(m.tick(at: at(7.5)) == [.resetTranscript, .send("actually stop")])
	}

	@Test("the agent's own voice coming back through the microphone is not you talking over it")
	func echoIsIgnored() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("what is blocked", at: at(0))
		_ = m.tick(at: at(3))
		_ = m.replyArrived(messageID: "m1", text: "Three bets are blocked on review.")
		#expect(m.heard("three bets are blocked", at: at(4)).isEmpty)
		#expect(m.phase == .speaking)
		// One stray word is not enough either.
		#expect(m.heard("okay", at: at(4.5)).isEmpty)
		#expect(m.phase == .speaking)
	}

	@Test("pending text is what was heard and not yet sent")
	func pending() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		#expect(m.pendingText == nil)
		_ = m.heard("remind me tomorrow", at: at(0))
		#expect(m.pendingText == "remind me tomorrow")
	}

	@Test("the reply is read aloud, more replies queue behind it, and listening resumes after")
	func replyThenListenAgain() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("what is blocked", at: at(0))
		_ = m.tick(at: at(3))
		#expect(m.replyArrived(messageID: "m1") == [.resetTranscript, .speak(messageID: "m1")])
		#expect(m.phase == .speaking)
		#expect(m.replyArrived(messageID: "m2") == [.speak(messageID: "m2")])
		#expect(m.speechFinished() == [.resetTranscript, .startListening])
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
		_ = m.tick(at: at(3))
		#expect(m.replyFailed() == [.resetTranscript, .startListening])
		#expect(m.phase == .listening)
		#expect(m.replyFailed().isEmpty)
	}

	@Test("interrupting stops the voice and listens at once")
	func interrupts() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("tell me more please", at: at(0))
		_ = m.tick(at: at(3))
		_ = m.replyArrived(messageID: "m1")
		#expect(m.interrupt() == [.stopSpeaking, .resetTranscript, .startListening])
		#expect(m.phase == .listening)
		#expect(m.interrupt().isEmpty)
	}

	@Test("no reply for a long time puts it back to listening")
	func replyTimeout() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("are you there", at: at(0))
		_ = m.tick(at: at(3))
		#expect(m.tick(at: at(60)).isEmpty)
		#expect(m.tick(at: at(95)) == [.resetTranscript, .startListening])
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
		_ = m.tick(at: at(3))
		_ = m.replyArrived(messageID: "m1")
		#expect(m.setMuted(true) == [.stopListening])
		#expect(m.speechFinished() == [.resetTranscript])
		#expect(m.setMuted(false) == [.startListening])
	}

	@Test("ending stops everything")
	func ends() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		#expect(m.end() == [.stopListening, .stopSpeaking])
	}

	@Test("the agent's own words are echo, fillers are fillers")
	func echoAndFillers() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("what is blocked", at: at(0))
		_ = m.tick(at: at(3))
		_ = m.replyArrived(messageID: "m1", text: "Three bets are blocked on review.")
		#expect(m.isEcho("three bets are"))
		#expect(!m.isEcho("what about billing"))
		#expect(m.isFiller("um"))
	}

	@Test("go on after being cut off goes back to speaking")
	func resumesSpeaking() {
		var m = LiveVoiceMachine()
		_ = m.begin()
		_ = m.heard("what is blocked", at: at(0))
		_ = m.tick(at: at(3))
		_ = m.replyArrived(messageID: "m1", text: "Three bets.")
		_ = m.interrupt()
		#expect(m.phase == .listening)
		#expect(m.resumeSpeaking(text: "Four bets remain") == [.resetTranscript])
		#expect(m.phase == .speaking)
		#expect(m.isEcho("bets remain"))
	}
}
