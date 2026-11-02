import MaskinCore

/// Phase dividers for the Activity page, derived from the status moves the events already carry
/// (`data.changes` with the status old and new). An item's phase is the status the object was in
/// when it happened: the `to` of the latest status move at or before it, or the `from` of the
/// first move for everything earlier. With no status move in the timeline there are no phases.
enum ActivityPhases {
	/// Status per item id, `nil` where the timeline does not say.
	static func statuses(of items: [TimelineItem]) -> [String: String] {
		let chronological = items.filter { $0.date != nil }.sorted {
			($0.date ?? .distantPast, $0.eventId ?? 0) < ($1.date ?? .distantPast, $1.eventId ?? 0)
		}
		guard let firstMove = chronological.first(where: { $0.statusChange != nil })?.statusChange else { return [:] }
		var current = firstMove.from
		var out: [String: String] = [:]
		for item in chronological {
			if let move = item.statusChange { current = move.to }
			if let current { out[item.id] = current }
		}
		return out
	}

	/// Item ids that end a block when read newest first, with the status that block was in: the
	/// divider is drawn right below such an entry, headed by the phase it begins.
	static func dividers(newestFirst ids: [String], statuses: [String: String]) -> [String: String] {
		var out: [String: String] = [:]
		for (index, id) in ids.enumerated() {
			guard let status = statuses[id] else { continue }
			let older = index + 1 < ids.count ? statuses[ids[index + 1]] : nil
			if older != status { out[id] = status }
		}
		return out
	}
}
