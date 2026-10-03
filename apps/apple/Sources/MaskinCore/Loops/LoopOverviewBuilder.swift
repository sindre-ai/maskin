import Foundation

/// Turns the loop object's graph (and a few members' graphs) into the loop page's overview.
/// Pure, so the rules are tested without a server.
public enum LoopOverviewBuilder {
	static let membershipRelation = "in_loop"
	static let attachedRelation = "attached"
	/// Members whose attached files are looked up: one graph request each.
	public static let memberFileLookups = 5

	public static func members(from graph: ObjectGraph) -> [LoopMember] {
		graph.links
			.filter { $0.relation == membershipRelation && $0.isOutgoing && $0.otherType != "file" }
			.map { LoopMember(id: $0.otherId, type: $0.otherType, title: $0.otherTitle, status: $0.otherStatus ?? "") }
	}

	/// Top-level comments, newest first, with how many replies each has.
	public static func posts(from events: [ObjectEvent]) -> [LoopPost] {
		let comments = events.filter { $0.action == "commented" }
		var replies: [Int: Int] = [:]
		for event in comments {
			if let parent = parentID(of: event) { replies[parent, default: 0] += 1 }
		}
		return comments.compactMap { event in
			guard parentID(of: event) == nil,
				let text = event.data?["content"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
				!text.isEmpty
			else { return nil }
			let isDecision: Bool
			if case .object? = event.data?["decision"] { isDecision = true } else { isDecision = false }
			return LoopPost(
				id: event.id, actorID: event.actorId, text: text, date: event.createdAt,
				replyCount: replies[event.id] ?? 0, isDecision: isDecision)
		}
		.sorted { ($0.date ?? .distantPast, $0.id) > ($1.date ?? .distantPast, $1.id) }
	}

	/// Files attached to the object the graph belongs to.
	public static func files(from graph: ObjectGraph, sourceTitle: String?) -> [LoopOutput] {
		graph.links
			.filter { $0.relation == attachedRelation && $0.isOutgoing && $0.otherType == "file" }
			.map { LoopOutput(id: $0.otherId, name: $0.otherTitle, sourceTitle: sourceTitle) }
	}

	/// The loop's own files first, then members' files, each file once. HTML leads: it is the
	/// presentable output.
	public static func outputs(loopFiles: [LoopOutput], memberFiles: [LoopOutput]) -> [LoopOutput] {
		var seen = Set<String>()
		let all = (loopFiles + memberFiles).filter { seen.insert($0.id).inserted }
		return all.filter(\.isHTML) + all.filter { !$0.isHTML }
	}

	private static func parentID(of event: ObjectEvent) -> Int? {
		guard case .number(let n)? = event.data?["parentEventId"] else { return nil }
		return Int(n)
	}
}
