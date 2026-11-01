import Testing

@testable import MaskinCore

@Suite("Call orb state") struct CallOrbStateTests {
	@Test func anUnconnectedCallIsConnecting() {
		#expect(CallOrbState.derive(phase: .listening, isMuted: false, isConnected: false) == .connecting)
		#expect(CallOrbState.derive(phase: .speaking, isMuted: true, isConnected: false) == .connecting)
	}

	@Test func eachPhaseMapsToItsState() {
		#expect(CallOrbState.derive(phase: .listening, isMuted: false, isConnected: true) == .listening)
		#expect(CallOrbState.derive(phase: .thinking, isMuted: false, isConnected: true) == .thinking)
		#expect(CallOrbState.derive(phase: .speaking, isMuted: false, isConnected: true) == .speaking)
	}

	@Test func mutedOnlyShowsWhenItIsYourTurn() {
		#expect(CallOrbState.derive(phase: .listening, isMuted: true, isConnected: true) == .muted)
		#expect(CallOrbState.derive(phase: .speaking, isMuted: true, isConnected: true) == .speaking)
		#expect(CallOrbState.derive(phase: .thinking, isMuted: true, isConnected: true) == .thinking)
	}

	@Test func theLevelComesFromTheSideThatIsTalking() {
		#expect(CallOrbState.listening.levelSource == .microphone)
		#expect(CallOrbState.speaking.levelSource == .agent)
		#expect(CallOrbState.thinking.levelSource == .none)
		#expect(CallOrbState.muted.levelSource == .none)
		#expect(CallOrbState.connecting.levelSource == .none)
	}

	@Test func eachStateIsAnnounced() {
		#expect(CallOrbState.listening.accessibilityLabel == "Listening")
		#expect(CallOrbState.speaking.accessibilityLabel == "Agent speaking")
	}
}

@Suite("Audio level smoother") struct AudioLevelSmootherTests {
	@Test func itRisesFasterThanItFalls() {
		var up = AudioLevelSmoother()
		let risen = up.update(target: 1, dt: 0.06)
		var down = AudioLevelSmoother()
		down.update(target: 1, dt: 5)
		let fallen = 1 - down.update(target: 0, dt: 0.06)
		#expect(risen > fallen)
	}

	@Test func oneAttackTimeConstantCoversAboutTwoThirds() {
		var smoother = AudioLevelSmoother(attack: 0.06, release: 0.25)
		#expect(abs(smoother.update(target: 1, dt: 0.06) - 0.632) < 0.01)
	}

	@Test func thePathDoesNotDependOnHowOftenItIsFed() {
		var coarse = AudioLevelSmoother()
		coarse.update(target: 1, dt: 0.1)
		var fine = AudioLevelSmoother()
		for _ in 0..<10 { fine.update(target: 1, dt: 0.01) }
		#expect(abs(coarse.value - fine.value) < 0.0001)
	}

	@Test func itSettlesOnTheTargetAndStaysInRange() {
		var smoother = AudioLevelSmoother()
		smoother.update(target: 4, dt: 10)
		#expect(smoother.value <= 1 && smoother.value > 0.99)
		smoother.update(target: -2, dt: 10)
		#expect(smoother.value >= 0 && smoother.value < 0.01)
	}

	@Test func badInputIsTreatedAsSilenceAndNoTimePassesNoChange() {
		var smoother = AudioLevelSmoother()
		smoother.update(target: 0.5, dt: 10)
		let held = smoother.value
		#expect(smoother.update(target: 1, dt: 0) == held)
		smoother.update(target: .nan, dt: 10)
		#expect(smoother.value < 0.01)
	}

	@Test func shapingLiftsQuietSpeechAndCapsLoudSound() {
		#expect(AudioLevelSmoother.shaped(0) == 0)
		#expect(AudioLevelSmoother.shaped(-1) == 0)
		#expect(AudioLevelSmoother.shaped(.nan) == 0)
		#expect(AudioLevelSmoother.shaped(0.05) > 0.25)
		#expect(AudioLevelSmoother.shaped(1) == 1)
		#expect(AudioLevelSmoother.shaped(0.1) < AudioLevelSmoother.shaped(0.2))
	}

	@Test func theMeterKeepsTheLatestOfEachSideAndResets() {
		let meter = CallLevelMeter()
		meter.record(input: 0.2)
		meter.record(output: 0.4)
		#expect(meter.input == 0.2 && meter.output == 0.4)
		meter.reset()
		#expect(meter.input == 0 && meter.output == 0)
	}
}
