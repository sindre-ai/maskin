import Testing

@testable import MaskinCore

@Suite("DictationAccumulator")
struct DictationAccumulatorTests {
	@Test func showsTheRunningTranscript() {
		var acc = DictationAccumulator()
		acc.update("hello")
		acc.update("hello there")
		#expect(acc.text == "hello there")
	}

	@Test func keepsEarlierTextAcrossARestart() {
		var acc = DictationAccumulator()
		acc.update("first sentence")
		acc.roll()
		acc.update("second")
		#expect(acc.text == "first sentence second")
		acc.roll()
		acc.update("third")
		#expect(acc.text == "first sentence second third")
	}

	@Test func aRestartThatHearsNothingLosesNothing() {
		var acc = DictationAccumulator()
		acc.update("kept")
		acc.roll()
		acc.roll()
		#expect(acc.text == "kept")
	}

	@Test func startsEmpty() {
		#expect(DictationAccumulator().text == "")
	}
}

@Suite("DictationRestartPolicy")
struct DictationRestartPolicyTests {
	@Test func restartsAfterAPauseThatHeardSpeech() {
		var policy = DictationRestartPolicy()
		#expect(policy.taskEnded(ranFor: 0.2, heardText: true, fatal: false) == .restart)
	}

	@Test func restartsAfterALongSilentRun() {
		var policy = DictationRestartPolicy()
		#expect(policy.taskEnded(ranFor: 5, heardText: false, fatal: false) == .restart)
	}

	@Test func stopsOnAFatalError() {
		var policy = DictationRestartPolicy()
		#expect(policy.taskEnded(ranFor: 30, heardText: true, fatal: true) == .stop)
	}

	@Test func givesUpAfterRepeatedInstantFailures() {
		var policy = DictationRestartPolicy()
		var decisions: [DictationRestartPolicy.Decision] = []
		for _ in 0..<DictationRestartPolicy.maxQuickFailures {
			decisions.append(policy.taskEnded(ranFor: 0.01, heardText: false, fatal: false))
		}
		#expect(decisions.last == .stop)
		#expect(decisions.dropLast().allSatisfy { $0 == .restart })
	}

	@Test func aUsefulRunResetsTheFailureCount() {
		var policy = DictationRestartPolicy()
		_ = policy.taskEnded(ranFor: 0.01, heardText: false, fatal: false)
		_ = policy.taskEnded(ranFor: 0.01, heardText: false, fatal: false)
		_ = policy.taskEnded(ranFor: 3, heardText: true, fatal: false)
		#expect(policy.quickFailures == 0)
		#expect(policy.taskEnded(ranFor: 0.01, heardText: false, fatal: false) == .restart)
	}
}
