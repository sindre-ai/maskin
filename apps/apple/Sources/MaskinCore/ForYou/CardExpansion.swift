import Foundation
import Observation

/// Which For you decision cards are showing their expanded form (object chip, suggested line,
/// reply composer). Cards start the way the Display setting says (compact by default); the reader
/// opens or folds one by hand, or it opens itself while the reply is being worked on. Per card, in
/// memory: a relaunch starts from the setting again.
@MainActor @Observable
public final class CardExpansion {
	/// The Display setting: rows start open.
	public private(set) var startsOpen = false
	/// Cards the reader flipped away from `startsOpen`.
	private var flipped: Set<String> = []

	public init() {}

	/// What keeps a card open without the reader asking: the composer has focus or a Chief of Staff
	/// thread about the card is open. Typed text does NOT: Show less folds the card and keeps the
	/// text, and the folded card carries a "Draft" tag (the review's "collapsing loses your text").
	public struct Engagement: Equatable, Sendable {
		public var composerFocused: Bool
		public var hasDraft: Bool
		public var threadOpen: Bool

		public init(composerFocused: Bool = false, hasDraft: Bool = false, threadOpen: Bool = false) {
			self.composerFocused = composerFocused
			self.hasDraft = hasDraft
			self.threadOpen = threadOpen
		}

		public var isEngaged: Bool { composerFocused || threadOpen }
	}

	/// Expanded when opened by hand or engaged.
	public static func isExpanded(manual: Bool, engagement: Engagement) -> Bool {
		manual || engagement.isEngaged
	}

	/// Changing the default drops the reader's per-card flips: every row starts the new way.
	public func setStartsOpen(_ open: Bool) {
		guard open != startsOpen else { return }
		startsOpen = open
		flipped = []
	}

	/// Open by the setting, or by the reader's hand against it.
	public func isManuallyExpanded(_ id: String) -> Bool { startsOpen != flipped.contains(id) }

	public func isExpanded(_ id: String, engagement: Engagement = Engagement()) -> Bool {
		Self.isExpanded(manual: isManuallyExpanded(id), engagement: engagement)
	}

	public func expand(_ id: String) {
		if startsOpen { flipped.remove(id) } else { flipped.insert(id) }
	}

	public func collapse(_ id: String) {
		if startsOpen { flipped.insert(id) } else { flipped.remove(id) }
	}

	/// "Show less" only means something while nothing is holding the card open.
	public func canCollapse(_ id: String, engagement: Engagement = Engagement()) -> Bool {
		!engagement.isEngaged
	}

	/// Forgets cards that left the feed so the set cannot grow without bound.
	public func prune(keeping ids: Set<String>) {
		let kept = flipped.intersection(ids)
		if kept != flipped { flipped = kept }
	}
}

/// Where the names of the card's own object appear inside the Chief of Staff's message, so the
/// view can underline them as links that open it.
public enum ObjectLinks {
	/// Ranges of every case-insensitive occurrence of `name` in `text`. Empty for a blank name.
	public static func ranges(of name: String?, in text: String) -> [Range<String.Index>] {
		guard let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty
		else { return [] }
		var found: [Range<String.Index>] = []
		var from = text.startIndex
		while from < text.endIndex,
			let range = text.range(of: name, options: [.caseInsensitive, .diacriticInsensitive], range: from..<text.endIndex)
		{
			found.append(range)
			from = range.upperBound
		}
		return found
	}
}
