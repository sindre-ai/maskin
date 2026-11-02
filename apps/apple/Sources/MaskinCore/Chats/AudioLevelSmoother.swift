import Foundation

/// Turns a jumpy audio level (a reading every 50 ms) into one that can drive an animation: it rises
/// quickly when the sound does and falls back slowly, so a word reads as a swell and not a flicker.
/// A one-pole filter per direction, with the time constants in seconds, so the result does not depend
/// on how often it is fed.
public struct AudioLevelSmoother: Sendable, Equatable {
	public var attack: Double
	public var release: Double
	public private(set) var value: Double = 0

	public init(attack: Double = 0.06, release: Double = 0.25) {
		self.attack = attack
		self.release = release
	}

	/// Moves toward `target` (0...1) for `dt` seconds and returns the new level.
	@discardableResult
	public mutating func update(target: Double, dt: Double) -> Double {
		let goal = min(1, max(0, target.isFinite ? target : 0))
		guard dt > 0 else { return value }
		let tau = goal > value ? attack : release
		let step = tau <= 0 ? 1 : 1 - exp(-dt / tau)
		value += (goal - value) * step
		return value
	}

	public mutating func reset() { value = 0 }

	/// WebRTC reports a linear level where ordinary speech sits around 0.02 to 0.3. This lifts that
	/// into the whole 0...1 range with a curve that keeps quiet speech visible without clipping loud.
	public static func shaped(_ raw: Double) -> Double {
		guard raw.isFinite, raw > 0 else { return 0 }
		return pow(min(1, raw * 3), 0.7)
	}
}

/// The latest raw audio levels of a call: what the microphone is hearing and what the agent is
/// saying. Written from WebRTC's stats callback on its own thread and read by the orb on every
/// frame, so it is locked and deliberately not observable (reading it must not re-render a view).
public final class CallLevelMeter: @unchecked Sendable {
	private let lock = NSLock()
	private var inputLevel = 0.0
	private var outputLevel = 0.0

	public init() {}

	public var input: Double { lock.withLock { inputLevel } }
	public var output: Double { lock.withLock { outputLevel } }

	public func record(input: Double? = nil, output: Double? = nil) {
		lock.withLock {
			if let input { inputLevel = input }
			if let output { outputLevel = output }
		}
	}

	public func reset() {
		lock.withLock {
			inputLevel = 0
			outputLevel = 0
		}
	}
}
