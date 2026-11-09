import MaskinCore

/// The Activity tab's filter chips: everything, only what people and agents wrote, or only the
/// system's own updates (status moves, edits). Pure, so the rule is tested without a view.
enum ActivityFilter: String, CaseIterable, Identifiable {
	case all, comments, updates

	var id: String { rawValue }

	var title: String {
		switch self {
		case .all: "All"
		case .comments: "Comments"
		case .updates: "Updates"
		}
	}

	func includes(_ item: TimelineItem) -> Bool {
		switch self {
		case .all: true
		case .comments: ActivityGrouping.kind(of: item) == .comment
		case .updates: ActivityGrouping.kind(of: item) == .event
		}
	}

	/// Filters the timeline by kind.
	func apply(to items: [TimelineItem]) -> [TimelineItem] {
		guard self != .all else { return items }
		return items.filter(includes)
	}
}

/// What the Activity page shows while the timeline is not there yet.
enum ActivityLoadState: Equatable {
	case loading, failed, ready

	/// `fetched` is true once one fetch has landed; `revalidateFailed` that the latest try failed.
	/// A cached timeline (`hasItems`) is always ready, even when the first fetch failed; `retrying`
	/// shows the skeleton again while Try again is in flight.
	static func of(fetched: Bool, revalidateFailed: Bool, hasItems: Bool = false, retrying: Bool = false)
		-> ActivityLoadState
	{
		if fetched || hasItems { return .ready }
		if retrying { return .loading }
		return revalidateFailed ? .failed : .loading
	}
}
