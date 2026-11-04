import Foundation

/// Where "working for 12s" counts from. A chat session stays `running` between turns, so the
/// session's own start is minutes or hours before the turn the reader is waiting on; it is only
/// the last resort. The reader's own send is the best anchor (it exists the moment they tap send,
/// before the backend has opened a turn, and it does not move when the turn briefly drops out of
/// the poll), then the turn's own start.
public enum LiveActivityClock {
	public static func since(sentAt: Date?, turnStartedAt: Date?, sessionStartedAt: Date?) -> Date? {
		sentAt ?? turnStartedAt ?? sessionStartedAt
	}
}

/// What the one-line live row under "X is working on it" says. Pure, so the states are testable:
/// a step label while steps flow, "Starting…" before the first, and "Still working…" once nothing
/// new has happened for `stallAfter`, so a long silent tool call never reads as a frozen "working".
public struct LiveActivityLine: Equatable, Sendable {
	public enum Phase: Equatable, Sendable {
		case starting
		case active
		case stalled
	}

	public var phase: Phase
	/// The line itself: the newest step's label, the session's own status, or a stalled/starting text.
	public var text: String
	/// The step the line describes, if any (a stalled line still points at the last one).
	public var step: ActivityStep?
	/// The last moment anything happened (a step started or finished).
	public var lastActivityAt: Date?

	public static let stallAfter: TimeInterval = 60

	public static func resolve(
		turn: ActivityTurn?, fallbackActivity: String?, startedAt: Date?, now: Date,
		stallAfter: TimeInterval = LiveActivityLine.stallAfter
	) -> LiveActivityLine {
		let fallback = fallbackActivity?.trimmingCharacters(in: .whitespacesAndNewlines)
		let step = turn?.currentStep
		let label = step?.label.trimmingCharacters(in: .whitespacesAndNewlines)
		let stepLabel = (label?.isEmpty == false) ? label : nil
		let last =
			[step?.finishedAt, step?.startedAt, turn?.startedAt, startedAt].compactMap { $0 }.max()
		let quiet = last.map { now.timeIntervalSince($0) >= stallAfter } ?? false

		let known = stepLabel ?? (fallback?.isEmpty == false ? fallback : nil)
		guard let known else {
			let text = quiet ? "Still working…" : "Starting…"
			return LiveActivityLine(phase: quiet ? .stalled : .starting, text: text, step: nil, lastActivityAt: last)
		}
		if quiet {
			return LiveActivityLine(
				phase: .stalled, text: "Still working… \(known)", step: step, lastActivityAt: last)
		}
		return LiveActivityLine(phase: .active, text: known, step: step, lastActivityAt: last)
	}
}
