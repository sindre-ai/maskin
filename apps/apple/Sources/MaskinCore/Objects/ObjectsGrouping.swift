import Foundation

public enum ObjectsGrouping: String, Sendable, CaseIterable, Identifiable {
	case status
	case none

	public var id: String { rawValue }
	public var title: String {
		switch self {
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
}

public enum ObjectsGrouper {
	/// Buckets objects by status in the workspace's configured order (per type when no type is chosen) (statuses the schema doesn't
	/// list come last, alphabetically), skipping empty buckets, newest-updated first within one.
	public static func group(
		_ objects: [WorkObject], by grouping: ObjectsGrouping, schema: ObjectsSchema, type: String?
	) -> [ObjectGroup] {
		let sorted = objects.sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
		switch grouping {
		case .none:
			return sorted.isEmpty ? [] : [ObjectGroup(id: "", title: nil, objects: sorted)]
		case .status where type == nil:
			// "All types": one run of status sections per type, so each type's own statuses (a bet's
			// "active" is not a task's "in progress") are grouped under it.
			let present = Set(sorted.map(\.type))
			let order = schema.types.filter(present.contains) + present.subtracting(schema.types).sorted()
			return order.flatMap { kind -> [ObjectGroup] in
				let kindName = schema.displayName(for: kind)
				return group(sorted.filter { $0.type == kind }, by: .status, schema: schema, type: kind).map {
					ObjectGroup(
						id: "\(kind)/\($0.id)", title: "\(kindName) · \($0.title ?? $0.id)",
						objects: $0.objects)
				}
			}
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
