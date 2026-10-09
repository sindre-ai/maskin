import Foundation

public enum ObjectsGrouping: String, Sendable, CaseIterable, Identifiable {
	/// Processing (agents at work), then Needs you, then the rest: the default one-type view.
	case attention
	case type
	case status
	case none

	public var id: String { rawValue }
	public var title: String {
		switch self {
		case .attention: "Attention"
		case .type: "Type"
		case .status: "Status"
		case .none: "None"
		}
	}
}

public struct ObjectGroup: Identifiable, Sendable, Equatable {
	/// The raw group value (a status), or empty for the single ungrouped section.
	public var id: String
	public var title: String?
	public var objects: [WorkObject]
	/// The group is an object type (`id` is the type key) rather than a status.
	public var isType = false
	/// The group is an attention bucket (Processing, Needs you, Other).
	public var isAttention = false
}

/// How urgently an object wants the person, within its type group (lower sorts first):
/// unread, then the rest of what needs them (a review, a decision), then blocked, active, done.
public enum ObjectsUrgency {
	public static func rank(_ object: WorkObject) -> Int {
		let status = object.status.lowercased()
		if done.contains(status) { return 4 }
		if object.unreadCount > 0 { return 0 }
		if needsYou(object) { return 1 }
		if blocked.contains(status) || status.contains("block") { return 2 }
		return 3
	}

	private static let blocked: Set<String> = ["paused"]
	private static let done: Set<String> = [
		"done", "validated", "succeeded", "failed", "archived", "discarded", "parked", "scored", "clustered",
	]
}

public enum ObjectsGrouper {
	/// Buckets objects by type or status (the workspace's configured order; ones the schema doesn't
	/// list come last, alphabetically), skipping empty buckets. Inside a bucket the objects follow
	/// `sort`: by default needs you first, then blocked, active, done, newest-updated within each.
	public static func group(
		_ objects: [WorkObject], by grouping: ObjectsGrouping, schema: ObjectsSchema, type: String?,
		sort: ObjectsSort = .needsYou
	) -> [ObjectGroup] {
		let sorted = ObjectsSorter.sorted(objects, by: sort)
		switch grouping {
		case .attention:
			let buckets: [(id: String, title: String)] = [
				("processing", "Processing"), ("needs_you", "Needs you"), ("other", "Other"),
			]
			func bucket(_ object: WorkObject) -> String {
				if ObjectsUrgency.needsYou(object) { return "needs_you" }
				switch StatusCategory.of(object.status) {
				case .needsYou: return "needs_you"
				case .active: return "processing"
				default: return object.hasActiveSession ? "processing" : "other"
				}
			}
			return buckets.compactMap { b in
				let items = sorted.filter { bucket($0) == b.id }
				return items.isEmpty ? nil : ObjectGroup(id: b.id, title: b.title, objects: items, isAttention: true)
			}
		case .type:
			let present = Set(sorted.map(\.type))
			let known = schema.types.filter(present.contains)
			let unknown = present.subtracting(schema.types).sorted()
			return (known + unknown).map { type in
				ObjectGroup(
					id: type, title: schema.displayName(for: type), objects: sorted.filter { $0.type == type },
					isType: true)
			}
		case .none:
			return sorted.isEmpty ? [] : [ObjectGroup(id: "", title: nil, objects: sorted)]
		case .status:
			let order = schema.statuses(for: type)
			let present = Set(sorted.map(\.status))
			let known = order.filter(present.contains)
			let unknown = present.subtracting(order).sorted()
			return (known + unknown).map { status in
				ObjectGroup(
					id: status, title: status.replacingOccurrences(of: "_", with: " "),
					objects: sorted.filter { $0.status == status })
			}
		}
	}
}
