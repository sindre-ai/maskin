import Foundation

/// Keeps what was recognised across recogniser restarts. Each recognition task reports only its own
/// utterance, so when one ends on a pause and a new one begins, the finished text is committed and
/// the new transcript is appended to it. Pure strings only: no indices to go stale.
public struct DictationAccumulator: Equatable, Sendable {
	public private(set) var committed = ""
	public private(set) var current = ""

	public init() {}

	/// The running transcript of the task that is listening now (replaces the previous partial).
	public mutating func update(_ transcript: String) { current = transcript }

	/// The task ended: keep what it heard and start the next one from empty.
	public mutating func roll() {
		committed = DictationText.merge(base: committed, transcript: current)
		current = ""
	}

	/// Everything recognised so far, across restarts.
	public var text: String { DictationText.merge(base: committed, transcript: current) }
}

/// Decides whether a recogniser task that ended should be replaced by a new one, so recording
/// continues until the person taps Done or Discard. It refuses to loop on a recogniser that keeps
/// failing at once (no speech engine, no input, a revoked permission).
public struct DictationRestartPolicy: Equatable, Sendable {
	public enum Decision: Equatable, Sendable { case restart, stop }

	/// A task that ends sooner than this without hearing anything counts as a quick failure.
	public static let usefulRun: TimeInterval = 1.0
	/// Consecutive quick failures tolerated before giving up.
	public static let maxQuickFailures = 3

	public private(set) var quickFailures = 0

	public init() {}

	public mutating func taskEnded(ranFor: TimeInterval, heardText: Bool, fatal: Bool) -> Decision {
		if fatal { return .stop }
		if heardText || ranFor >= Self.usefulRun {
			quickFailures = 0
			return .restart
		}
		quickFailures += 1
		return quickFailures >= Self.maxQuickFailures ? .stop : .restart
	}
}
