import Foundation

public enum ObjectsGrouping: String, Sendable, CaseIterable, Identifiable {
	case type
	case status
	case none

	public var id: String { rawValue }
	public var title: String {
		switch self {
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
}

/// How urgently an object wants the person, within its type group (lower sorts first).
public enum ObjectsUrgency {
	public static func rank(_ object: WorkObject) -> Int {
		let status = object.status.lowercased()
		if done.contains(status) { return 3 }
		if blocked.contains(status) || status.contains("block") || status.contains("decide") { return 1 }
		if object.unreadCount > 0 { return 0 }
		return 2
	}

	private static let blocked: Set<String> = ["in_review", "paused"]
	private static let done: Set<String> = [
		"done", "validated", "succeeded", "failed", "archived", "discarded", "parked", "scored", "clustered",
	]
}

public enum ObjectsGrouper {
	/// Buckets objects by status in the workspace's configured order (statuses the schema doesn't
	/// list come last, alphabetically), skipping empty buckets, newest-updated first within one.
	public static func group(
		_ objects: [WorkObject], by grouping: ObjectsGrouping, schema: ObjectsSchema, type: String?
	) -> [ObjectGroup] {
		let sorted = objects.sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
		switch grouping {
		case .type:
			let present = Set(sorted.map(\.type))
			let known = schema.types.filter(present.contains)
			let unknown = present.subtracting(schema.types).sorted()
			return (known + unknown).map { type in
				let inType = sorted.filter { $0.type == type }
				// Stable: `sorted` is already newest-first, so rank ties keep that order.
				let ranked = inType.enumerated().sorted {
					let (a, b) = (ObjectsUrgency.rank($0.element), ObjectsUrgency.rank($1.element))
					return a != b ? a < b : $0.offset < $1.offset
				}.map(\.element)
				return ObjectGroup(id: type, title: schema.displayName(for: type), objects: ranked, isType: true)
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
