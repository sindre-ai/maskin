import Foundation

public enum ObjectsGrouping: String, Sendable, CaseIterable, Identifiable, Codable {
	/// Processing (agents at work), then Needs you, then the rest.
	case attention
	case type
	/// By status, in the workspace's order; with every type showing, one run of statuses per type.
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
	/// The raw group value (a status, a type, or `type/status`), or empty for the single
	/// ungrouped section.
	public var id: String
	public var title: String?
	public var objects: [WorkObject]
	/// The group is an object type (`id` is the type key) rather than a status.
	public var isType = false
	/// The group is an attention bucket (Processing, Needs you, Other).
	public var isAttention = false
	/// The status every object in the group shares, when grouped by status.
	public var status: String?
	/// The type every object in the group shares, when the group is scoped to one.
	public var type: String?

	public init(
		id: String, title: String?, objects: [WorkObject], isType: Bool = false, isAttention: Bool = false,
		status: String? = nil, type: String? = nil
	) {
		self.id = id
		self.title = title
		self.objects = objects
		self.isType = isType
		self.isAttention = isAttention
		self.status = status
		self.type = type
	}
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
	/// Types follow the product order (Bets, Insights, Tasks…), then the rest by label.
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
				return items.isEmpty ? nil : ObjectGroup(id: b.id, title: b.title, objects: items, isAttention: true, type: type)
			}
		case .type:
			return typeOrder(of: sorted, schema: schema).map { type in
				ObjectGroup(
					id: type, title: ObjectTypeCatalog.pluralLabel(for: type, displayName: schema.displayName(for: type)),
					objects: sorted.filter { $0.type == type }, isType: true, type: type)
			}
		case .none:
			return sorted.isEmpty ? [] : [ObjectGroup(id: "", title: nil, objects: sorted, type: type)]
		case .status where type == nil:
			// "All types": one run of status sections per type, so each type's own statuses (a bet's
			// "active" is not a task's "in progress") are grouped under it.
			return typeOrder(of: sorted, schema: schema).flatMap { kind -> [ObjectGroup] in
				let kindName = ObjectTypeCatalog.pluralLabel(for: kind, displayName: schema.displayName(for: kind))
				return group(sorted.filter { $0.type == kind }, by: .status, schema: schema, type: kind, sort: sort).map {
					ObjectGroup(
						id: "\(kind)/\($0.id)", title: "\(kindName) · \($0.title ?? $0.id)", objects: $0.objects,
						status: $0.status, type: kind)
				}
			}
		case .status:
			let order = schema.statuses(for: type)
			let present = Set(sorted.map(\.status))
			let known = order.filter(present.contains)
			let unknown = present.subtracting(order).sorted()
			return (known + unknown).map { status in
				ObjectGroup(
					id: status, title: statusTitle(status), objects: sorted.filter { $0.status == status },
					status: status, type: type)
			}
		}
	}

	/// "in_progress" → "In progress".
	public static func statusTitle(_ status: String) -> String {
		let words: String
		switch status {
		case "todo": words = "To do"
		case "waiting_for_input": words = "Needs you"
		default: words = status.replacingOccurrences(of: "_", with: " ")
		}
		return words.prefix(1).uppercased() + words.dropFirst()
	}

	private static func typeOrder(of objects: [WorkObject], schema: ObjectsSchema) -> [String] {
		let present = Set(objects.map(\.type))
		return ObjectTypeCatalog.sorted(Array(present)) { schema.displayName(for: $0) }
	}
}
