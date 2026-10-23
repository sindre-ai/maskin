import Foundation

/// One line of HANDLED TODAY: what the reader did and who carries on. Pure, so it is tested
/// without a view.
public struct HandledSummary: Equatable, Sendable {
	public enum Mark: Sendable, Equatable {
		/// A tick: a call was taken.
		case done
		/// Held, with the reader's reason on the thread.
		case held
		/// Waiting for the network.
		case queued
	}

	public var mark: Mark
	public var label: String
	public var detail: String
	/// The call can still be taken back (it has not been sent, or it was a dismissal).
	public var canUndo: Bool

	/// Nil for an entry that has no record to summarise (an open card).
	public static func make(for entry: FeedEntry, sender: String?) -> HandledSummary? {
		guard let record = entry.record else { return nil }
		let object = entry.card.objectTitle?.trimmed.nonEmpty ?? entry.card.headline
		let undoable: Bool = {
			if case .held = record.phase { return true }
			if case .dismissed = record.kind, case .sent = record.phase { return true }
			return false
		}()
		func detail(_ tail: String?) -> String { [object, tail].compactMap { $0 }.joined(separator: " \u{00B7} ") }

		if case .queued = record.phase {
			let label: String
			switch record.kind {
			case .option(let option): label = "Queued \u{00B7} \(option)"
			case .reply: label = "Queued reply"
			case .dismissed: label = "Queued \u{00B7} marked read"
			}
			return HandledSummary(
				mark: .queued, label: label, detail: detail("sends when you\u{2019}re back"), canUndo: undoable)
		}
		switch record.kind {
		case .option(let option) where HoldReason.isHold(option):
			return HandledSummary(
				mark: .held, label: "Held",
				detail: detail("\(sender ?? "The agent") has your reason"), canUndo: undoable)
		case .option(let option):
			return HandledSummary(
				mark: .done, label: option, detail: detail(sender.map { "\($0) carries on" }),
				canUndo: undoable)
		case .reply:
			return HandledSummary(mark: .done, label: "Replied", detail: detail(nil), canUndo: undoable)
		case .dismissed:
			return HandledSummary(mark: .done, label: "Marked read", detail: detail(nil), canUndo: undoable)
		}
	}
}
