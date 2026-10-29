import Foundation
import Testing

@testable import MaskinCore

@Suite("ReplyPacer") struct ReplyPacerTests {
	private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
	private func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

	/// Eight short sentences: four beats.
	private let reply = "One is here. Two is here. Three is here. Four is here. Five is here. Six is here. Seven is here. Eight is here."

	private func start(_ pace: LiveCallPace = .relaxed, text: String? = nil) -> (ReplyPacer, [ReplyPacer.Command]) {
		var p = ReplyPacer(pace: pace)
		let cmds = p.enqueue(id: "m1", text: text ?? reply, at: at(0))
		return (p, cmds)
	}

	@Test func readsTheFirstBeatThenBreaksThenReadsTheNext() {
		var (p, cmds) = start()
		#expect(cmds == [.speak(id: "m1#1", text: "One is here. Two is here.")])
		#expect(p.beatFinished(at: at(5)) == [.resetTranscript])
		#expect(p.isOnBreak)
		#expect(p.tick(at: at(6.5)).isEmpty)
		#expect(p.tick(at: at(6.9)) == [.speak(id: "m1#2", text: "Three is here. Four is here.")])
		#expect(!p.isOnBreak)
	}

	@Test func normalBreaksAreShorter() {
		var (p, _) = start(.normal)
		_ = p.beatFinished(at: at(5))
		#expect(p.tick(at: at(5.9)) == [.speak(id: "m1#2", text: "Three is here. Four is here.")])
	}

	@Test func theLastBeatFinishesTheReply() {
		var (p, _) = start(text: "Just one thought.")
		#expect(p.beatFinished(at: at(2)) == [.finished])
		#expect(p.state == .idle)
	}

	@Test func aShortAcknowledgementResumesAfterItHoldsStill() {
		var (p, _) = start()
		_ = p.beatFinished(at: at(5))
		#expect(p.heard("yes", at: at(5.5)).isEmpty)
		#expect(p.tick(at: at(5.8)).isEmpty)
		let cmds = p.tick(at: at(6.1))
		#expect(cmds.first == .resetTranscript)
		#expect(cmds.contains(.speak(id: "m1#2", text: "Three is here. Four is here.")))
	}

	@Test func anAcknowledgementThatTurnsIntoSomethingElseTakesOver() {
		var (p, _) = start()
		_ = p.beatFinished(at: at(5))
		_ = p.heard("yes", at: at(5.5))
		#expect(p.heard("yes but who owns it", at: at(5.8)) == [.takeOver("yes but who owns it")])
		#expect(p.state == .idle)
	}

	@Test func speakingDuringABreakTakesOverAtOnceAndKeepsTheRestForGoOn() {
		var (p, _) = start()
		_ = p.beatFinished(at: at(5))
		#expect(p.heard("what about billing", at: at(5.2)) == [.takeOver("what about billing")])
		#expect(p.canResume(at: at(20)))
		#expect(!p.canResume(at: at(40)))
		let resumed = p.resume(at: at(20))
		#expect(resumed == [.speak(id: "m1#2", text: "Three is here. Four is here.")])
	}

	@Test func wordsDuringABreakKeepTheBreakFromEnding() {
		var (p, _) = start()
		_ = p.beatFinished(at: at(5))
		_ = p.heard("ye", at: at(6.7))
		#expect(p.tick(at: at(7.0)).isEmpty)
	}

	@Test func waitHoldsUntilYouHaveFinishedThenSendsWhatYouAdded() {
		var (p, _) = start()
		_ = p.beatFinished(at: at(5))
		_ = p.heard("wait", at: at(5.5))
		#expect(p.state == .held(since: at(5.5)))
		// The break would have ended by now, but the reading stays held.
		#expect(p.tick(at: at(9)) == [.resetTranscript])
		#expect(p.tick(at: at(9.5)).isEmpty)
		_ = p.heard("wait what about billing", at: at(10))
		#expect(p.tick(at: at(10.5)).isEmpty)
		#expect(p.tick(at: at(11.4)) == [.takeOver("what about billing")])
	}

	@Test func aBareWaitStaysHeldThenGoOnContinues() {
		var (p, _) = start()
		_ = p.beatFinished(at: at(5))
		_ = p.heard("hold on", at: at(5.5))
		#expect(p.tick(at: at(7.0)) == [.resetTranscript])
		_ = p.heard("go on", at: at(12))
		let cmds = p.tick(at: at(12.6))
		#expect(cmds.contains(.speak(id: "m1#2", text: "Three is here. Four is here.")))
	}

	@Test func aHoldNobodyFollowsUpEndsAndIsResumableForAWhile() {
		var (p, _) = start()
		_ = p.beatFinished(at: at(5))
		_ = p.heard("stop", at: at(5.5))
		_ = p.tick(at: at(7))
		#expect(p.tick(at: at(36)) == [.finished])
		#expect(p.canResume(at: at(40)))
	}

	@Test func aCheckInComesAfterThreeBeatsOnlyOnceAndIsNotARealBeat() {
		let long = (1...16).map { "Sentence number \($0) here." }.joined(separator: " ")
		var (p, _) = start(text: long)
		var checkIns = 0
		var now: TimeInterval = 0
		var beats = 0
		while p.state != .idle, now < 400 {
			now += 10
			var cmds = p.beatFinished(at: at(now))
			now += 3
			cmds += p.tick(at: at(now))
			for case .speak(let id, _) in cmds {
				if id.contains("checkin") { checkIns += 1 } else { beats += 1 }
			}
			if cmds.contains(where: { if case .speak(let id, _) = $0 { id.contains("checkin") } else { false } }) {
				// The check-in is spoken, then a longer break.
				_ = p.beatFinished(at: at(now + 4))
				#expect(p.tick(at: at(now + 6)).isEmpty)
				now += 8
				cmds = p.tick(at: at(now))
				if cmds.contains(where: { if case .speak = $0 { true } else { false } }) { beats += 1 }
			}
		}
		#expect(checkIns == 1)
		#expect(beats >= 6)
	}

	@Test func normalPaceNeverChecksIn() {
		let long = (1...16).map { "Sentence number \($0) here." }.joined(separator: " ")
		var (p, _) = start(.normal, text: long)
		var spoken: [String] = []
		for step in 1...20 where p.state != .idle {
			var cmds = p.beatFinished(at: at(Double(step) * 10))
			cmds += p.tick(at: at(Double(step) * 10 + 2))
			spoken += cmds.compactMap { if case .speak(let id, _) = $0 { id } else { nil } }
		}
		#expect(!spoken.contains { $0.contains("checkin") })
	}

	@Test func aReplyArrivingWhileOneIsReadJoinsTheQueue() {
		var (p, _) = start(text: "First reply here.")
		#expect(p.enqueue(id: "m2", text: "Second reply here.", at: at(1)).isEmpty)
		_ = p.beatFinished(at: at(3))
		#expect(p.tick(at: at(5)) == [.speak(id: "m1#2", text: "Second reply here.")])
	}

	@Test func theUsersOwnTurnClearsWhatWasLeft() {
		var (p, _) = start()
		_ = p.beatFinished(at: at(5))
		p.discard()
		#expect(!p.hasRemaining && !p.canResume(at: at(6)))
	}

	@Test func interruptingMidBeatReplaysThatBeatOnGoOn() {
		var (p, _) = start()
		p.interrupted(at: at(2))
		#expect(p.resume(at: at(10)) == [.speak(id: "m1#2", text: "One is here. Two is here.")])
	}
}
