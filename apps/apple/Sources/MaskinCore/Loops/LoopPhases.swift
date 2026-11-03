import Foundation

/// One phase of a loop: a status of the objects moving through it, who works it, and what sits
/// in it. The backend has no phase concept; like the web's `loop-flow`, the member type's statuses
/// are the phases and a step belongs to the phase its event trigger fires from.
public struct LoopPhase: Identifiable, Equatable, Sendable {
	public var id: String { status }
	public var status: String
	public var members: [LoopMember]
	public var steps: [LoopStep]

	public var count: Int { members.count }
}

public enum LoopPhases {
	/// The type most members share (the loop's "primary" child), ties broken alphabetically.
	public static func primaryType(of members: [LoopMember]) -> String? {
		let counts = Dictionary(grouping: members, by: \.type).mapValues(\.count)
		return counts.max { ($0.value, $1.key) < ($1.value, $0.key) }?.key
	}

	/// Phases in workflow order: configured statuses first, then any status seen on a member but
	/// not configured. Statuses with neither members nor a step are dropped unless `keepEmpty`,
	/// so a long workflow doesn't bury the few that are in use.
	public static func build(
		members: [LoopMember], steps: [LoopStep], statusOrder: [String], keepEmpty: Bool = false
	) -> [LoopPhase] {
		guard let type = primaryType(of: members) else { return [] }
		let primary = members.filter { $0.type == type }
		var order = statusOrder
		for status in primary.map(\.status) where !order.contains(status) { order.append(status) }
		let byStatus = Dictionary(grouping: primary, by: \.status)
		return order.compactMap { status in
			let inPhase = byStatus[status] ?? []
			let owned = steps.filter { fromStatus($0) == status }
			if inPhase.isEmpty && owned.isEmpty && !keepEmpty { return nil }
			return LoopPhase(status: status, members: inPhase, steps: owned)
		}
	}

	/// Members still on their way, grouped by status in workflow order: everything but those in the
	/// workflow's last status. Statuses with nobody in them are dropped.
	public static func inMotion(members: [LoopMember], statusOrder: [String]) -> [LoopPhase] {
		let done = statusOrder.last
		let moving = members.filter { $0.status != done }
		var order = statusOrder
		for status in moving.map(\.status) where !order.contains(status) { order.append(status) }
		let byStatus = Dictionary(grouping: moving, by: \.status)
		return order.compactMap { status in
			guard let inPhase = byStatus[status], !inPhase.isEmpty else { return nil }
			return LoopPhase(status: status, members: inPhase, steps: [])
		}
	}

	/// The `from_status` an event trigger fires on, if it has one.
	static func fromStatus(_ step: LoopStep) -> String? {
		guard case .object(let config) = step.triggerConfig,
			case .string(let status)? = config["from_status"], !status.isEmpty
		else { return nil }
		return status
	}
}
