import Foundation

/// Related approvals folded into one card with a single "Approve all".
///
/// The rule (the mockup does not define one): an open ask joins a group when it is
/// - an approval: its recommended option is "Approve…" and can be undone,
/// - from the same agent, about the same kind of object, and takes the same recommended option, and
/// - not carrying a message to send (a draft is always read on its own card).
/// Three or more open asks with the same key make a group; fewer stay ordinary cards.
public struct ApprovalGroup: Identifiable, Equatable, Sendable {
	public struct Member: Identifiable, Equatable, Sendable {
		public var entry: FeedEntry
		/// Approved from this group (or its Approve all) and not taken back.
		public var isApproved: Bool
		public var id: String { entry.id }
	}

	public var id: String
	public var agentName: String?
	/// The object type key the cards are about ("wiki_page").
	public var objectType: String
	/// Every card the group holds, in the order the feed ranked them, approved ones included so a
	/// row does not jump when it is approved.
	public var members: [Member]

	public var openCount: Int { members.filter { !$0.isApproved }.count }
	public var approvedCount: Int { members.count - openCount }
	public var total: Int { members.count }
	/// Everything in the group has been approved.
	public var isDone: Bool { !members.isEmpty && openCount == 0 }
	public var openEntries: [FeedEntry] { members.filter { !$0.isApproved }.map(\.entry) }

	/// "Review 5 wiki pages". `typeLabel` is the workspace's name for the type ("Wiki page").
	public func title(typeLabel: String) -> String {
		"Review \(total) \(ApprovalGrouping.plural(typeLabel.lowercased(), count: total))"
	}

	/// "5 wiki pages approved."
	public func doneText(typeLabel: String) -> String {
		"\(total) \(ApprovalGrouping.plural(typeLabel.lowercased(), count: total)) approved."
	}
}

/// One thing in the "Needs you" list: a card, or a group of related approvals.
public enum FeedItem: Identifiable, Equatable, Sendable {
	case card(FeedEntry)
	case group(ApprovalGroup)

	public var id: String {
		switch self {
		case .card(let entry): entry.id
		case .group(let group): "group:" + group.id
		}
	}
}

public enum ApprovalGrouping {
	/// A group needs this many open asks to form.
	public static let minimumOpen = 3

	struct Key: Hashable, Sendable {
		var actorId: String
		var objectType: String
		var option: String
	}

	/// The key a card would group under, or nil when it cannot be grouped.
	static func groupKey(for card: ForYouCard) -> Key? {
		guard let actor = card.mention?.actorId, let type = card.objectType,
			let decision = card.decision, decision.draft == nil, decision.drafts.isEmpty,
			let option = decision.recommended, !option.destructive, isApprove(option.label)
		else { return nil }
		return Key(actorId: actor, objectType: type, option: option.label.trimmed.lowercased())
	}

	/// "Approve", "Approve and publish": the first word is approve.
	static func isApprove(_ label: String) -> Bool {
		label.lowercased().split(whereSeparator: { !$0.isLetter }).first == "approve"
	}

	/// The "Needs you" list with related approvals folded into groups. A group sits where its first
	/// open card was. `approvedIds` are cards approved from a group this sitting: they stay inside it
	/// as "Approved" rows, and a group whose cards are all approved stays at the top in its done state.
	public static func items(
		entries: [FeedEntry], approvedIds: Set<String>, agentName: (ForYouCard) -> String?
	) -> [FeedItem] {
		let open = entries.filter { $0.bucket == .needs }
		let approved = entries.filter { $0.bucket == .done && approvedIds.contains($0.id) }

		var order: [Key] = []
		var openByKey: [Key: [FeedEntry]] = [:]
		var approvedByKey: [Key: [FeedEntry]] = [:]
		for entry in open {
			guard let key = groupKey(for: entry.card) else { continue }
			if openByKey[key] == nil { order.append(key) }
			openByKey[key, default: []].append(entry)
		}
		for entry in approved {
			guard let key = groupKey(for: entry.card) else { continue }
			if openByKey[key] == nil, approvedByKey[key] == nil { order.append(key) }
			approvedByKey[key, default: []].append(entry)
		}

		var groups: [Key: ApprovalGroup] = [:]
		for key in order {
			let openEntries = openByKey[key] ?? []
			let approvedEntries = approvedByKey[key] ?? []
			// Formed at three open; it keeps its shape while any card is approved, so it does not
			// fall apart under the reader's thumb as the open count drops.
			guard openEntries.count >= minimumOpen || !approvedEntries.isEmpty else { continue }
			let members = (openEntries.map { Member(entry: $0, isApproved: false) }
				+ approvedEntries.map { Member(entry: $0, isApproved: true) })
				.sorted { ($0.entry.card.rank ?? .max, $0.id) < ($1.entry.card.rank ?? .max, $1.id) }
			let first = members[0].entry.card
			groups[key] = ApprovalGroup(
				id: "\(key.actorId)|\(key.objectType)|\(key.option)", agentName: agentName(first),
				objectType: key.objectType, members: members)
		}

		var items: [FeedItem] = []
		var placed: Set<Key> = []
		// A finished group has no open card to sit beside, so it leads the list.
		for key in order {
			if let group = groups[key], group.isDone {
				items.append(.group(group))
				placed.insert(key)
			}
		}
		for entry in open {
			if let key = groupKey(for: entry.card), let group = groups[key] {
				if placed.insert(key).inserted { items.append(.group(group)) }
			} else {
				items.append(.card(entry))
			}
		}
		return items
	}

	/// "wiki page" with 5 becomes "wiki pages". Plain English plurals only: the type names come from
	/// the workspace, so this stays a simple rule rather than a dictionary.
	public static func plural(_ noun: String, count: Int) -> String {
		guard count != 1 else { return noun }
		let lower = noun.lowercased()
		if let last = lower.last, let before = lower.dropLast().last,
			last == "y", !"aeiou".contains(before)
		{
			return String(noun.dropLast()) + "ies"
		}
		if lower.hasSuffix("s") || lower.hasSuffix("x") || lower.hasSuffix("ch") || lower.hasSuffix("sh") {
			return noun + "es"
		}
		return noun + "s"
	}
}
