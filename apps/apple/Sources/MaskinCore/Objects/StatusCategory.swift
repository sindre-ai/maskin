import Foundation

/// The five categories every workspace status falls into (handoff 1E). Visuals and the Approve
/// action come from the category, never from the status's name.
///
/// The API's workspace settings carry only the ordered status keys per type, no category field, so
/// the category is derived from the key with the table below and `.backlog` as the safe default for
/// a key nobody has taught the table (grey, no actions, no false urgency).
///
/// | Category  | Status keys                                                              |
/// |-----------|--------------------------------------------------------------------------|
/// | backlog   | backlog, todo, new, signal, define, proposed, paused, parked, holding     |
/// | needsYou  | in_review, waiting_for_input, any key containing "decide" or "waiting"    |
/// | active    | in_progress, active, live, processing, clustered, running, started        |
/// | done      | done, completed, validated, succeeded, scored, paid                       |
/// | cancelled | discarded, archived, failed, canceled, cancelled, declined                |
public enum StatusCategory: String, Sendable, CaseIterable, Equatable {
	case backlog
	case needsYou = "needs_you"
	case active
	case done
	case cancelled

	private static let table: [String: StatusCategory] = {
		var table: [String: StatusCategory] = [:]
		for key in ["backlog", "todo", "new", "signal", "define", "proposed", "paused", "parked", "holding"] {
			table[key] = .backlog
		}
		for key in ["in_review", "waiting_for_input"] { table[key] = .needsYou }
		for key in ["in_progress", "active", "live", "processing", "clustered", "running", "started"] {
			table[key] = .active
		}
		for key in ["done", "completed", "validated", "succeeded", "scored", "paid"] { table[key] = .done }
		for key in ["discarded", "archived", "failed", "canceled", "cancelled", "declined"] {
			table[key] = .cancelled
		}
		return table
	}()

	/// The category of a workspace status key.
	public static func of(_ status: String) -> StatusCategory {
		let key = status.lowercased()
		if let known = table[key] { return known }
		if key.contains("decide") || key.contains("waiting") { return .needsYou }
		return .backlog
	}

	/// Where Approve and Hold are offered: only on what wants the person or is under way.
	public var canApprove: Bool { self == .needsYou || self == .active }

	/// The category Approve moves into: Needs you → Active, Active → Done.
	public var approveTarget: StatusCategory? {
		switch self {
		case .needsYou: .active
		case .active: .done
		default: nil
		}
	}
}

/// What moving along a type's ordered statuses means, as pure functions of the workspace order.
public enum StatusFlow {
	/// The status Approve moves `status` to: the next status, in workspace order after the current
	/// one, whose category is the next category. Nil when there is none; the row then hides
	/// Approve (the person asks the Chief of Staff instead).
	public static func approveTarget(from status: String, in ordered: [String]) -> String? {
		guard let target = StatusCategory.of(status).approveTarget,
			let index = ordered.firstIndex(of: status)
		else { return nil }
		return ordered[(index + 1)...].first { StatusCategory.of($0) == target }
	}

	/// The status archiving an object of this type moves it to: `archived` when the type has it,
	/// else `discarded`, else the first status in the Cancelled category. Nil when none exists.
	public static func archiveTarget(in ordered: [String]) -> String? {
		if ordered.contains("archived") { return "archived" }
		if ordered.contains("discarded") { return "discarded" }
		return ordered.first { StatusCategory.of($0) == .cancelled }
	}
}

/// One object's status change, enough to put it back.
public struct StatusChange: Sendable, Equatable {
	public var id: String
	public var from: String
	public var to: String

	public init(id: String, from: String, to: String) {
		self.id = id
		self.from = from
		self.to = to
	}
}

/// A batch of status changes that landed, offered back as "Undo".
public struct StatusUndo: Sendable, Equatable {
	public var changes: [StatusChange]

	public init(changes: [StatusChange]) { self.changes = changes }

	public var isEmpty: Bool { changes.isEmpty }
	public var count: Int { changes.count }
}
