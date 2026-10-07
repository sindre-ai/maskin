import Foundation

extension ObjectsUrgency {
	/// The object is waiting on the person: something unread, a review to give, a decision to make.
	/// The data has no explicit "needs you" flag, so this reads the same signals the tiers do.
	public static func needsYou(_ object: WorkObject) -> Bool {
		if object.unreadCount > 0 { return true }
		let status = object.status.lowercased()
		return status == "in_review" || status.contains("decide") || status.contains("waiting")
	}
}

/// Orders a list of objects by the chosen sort.
public enum ObjectsSorter {
	public static func sorted(_ objects: [WorkObject], by sort: ObjectsSort) -> [WorkObject] {
		switch sort {
		case .updated:
			return newestFirst(objects)
		case .name:
			return objects.sorted {
				let order = $0.displayTitle.localizedStandardCompare($1.displayTitle)
				return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
			}
		case .needsYou:
			// Stable on the newest-first order, so ties inside a tier keep the freshest on top.
			return newestFirst(objects).enumerated().sorted {
				let (a, b) = (ObjectsUrgency.rank($0.element), ObjectsUrgency.rank($1.element))
				return a != b ? a < b : $0.offset < $1.offset
			}.map(\.element)
		}
	}

	private static func newestFirst(_ objects: [WorkObject]) -> [WorkObject] {
		objects.enumerated().sorted {
			let (a, b) = ($0.element.updatedAt ?? .distantPast, $1.element.updatedAt ?? .distantPast)
			return a != b ? a > b : $0.offset < $1.offset
		}.map(\.element)
	}
}

/// How a row's status word is coloured. Patina for what is running or wants the person, ink for
/// done, grey for paused or put away; never green, amber or blue.
public enum ObjectsStatusTone: Sendable, Equatable {
	case patina
	case ink
	case quiet
	case neutral

	public static func of(_ object: WorkObject) -> ObjectsStatusTone {
		let status = object.status.lowercased()
		if ["paused", "parked", "discarded", "archived", "holding"].contains(status) { return .quiet }
		if ["done", "completed", "validated", "succeeded", "failed", "scored", "clustered"].contains(status) {
			return .ink
		}
		if ObjectsUrgency.rank(object) <= 2 || object.hasActiveSession {
			return .patina
		}
		if ["active", "live", "in_progress", "running", "processing"].contains(status) { return .patina }
		return .neutral
	}
}
