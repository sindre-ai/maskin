import Foundation

// MARK: - Flow rooms

/// One flow's room in the Team list (spec 7 §6, FLOWS section). Conversations carry no flow
/// link in the API, so rooms are supplied by a `FlowRoomsSource` the screen wires in; a client
/// with no source simply has no FLOWS section.
public struct TeamFlowRoom: Identifiable, Equatable, Sendable {
	public var id: String
	public var name: String
	/// Who wrote the latest post, and what they wrote (the row shows its first clause).
	public var lastPostAuthor: String?
	public var lastPostText: String?
	public var lastActivity: Date?
	/// Agents running in this flow right now.
	public var workingCount: Int
	/// Flow posts have no per-user read state in the API yet, so this is 0 until they do.
	public var unreadCount: Int
	/// The flow itself, for opening its screen.
	public var loop: LoopSummary?

	public init(
		id: String, name: String, lastPostAuthor: String? = nil, lastPostText: String? = nil,
		lastActivity: Date? = nil, workingCount: Int = 0, unreadCount: Int = 0, loop: LoopSummary? = nil
	) {
		self.id = id
		self.name = name
		self.lastPostAuthor = lastPostAuthor
		self.lastPostText = lastPostText
		self.lastActivity = lastActivity
		self.workingCount = workingCount
		self.unreadCount = unreadCount
		self.loop = loop
	}

	/// The pin key, shared with conversations so one ordered list covers both.
	public var pinKey: String { TeamLayout.flowPinKey(id) }
}

public protocol FlowRoomsSource: Sendable {
	func flowRooms() async throws -> [TeamFlowRoom]
}

// MARK: - Display options and chips

/// The Display menu's choices (spec 7 §6). Persisted per user by `TeamPreferences`.
public struct TeamDisplayOptions: Codable, Equatable, Sendable {
	public enum Layout: String, Codable, CaseIterable, Sendable {
		case sections, oneList
		public var label: String { self == .sections ? "Grouped" : "Single list" }
	}
	public enum Grouping: String, Codable, CaseIterable, Sendable {
		case byTime, byPerson, newestFirst
		public var label: String {
			switch self {
			case .byTime: "By date"
			case .byPerson: "By person"
			case .newestFirst: "Newest first"
			}
		}
	}

	public var layout: Layout = .sections
	public var grouping: Grouping = .byTime
	public var showsFilterChips = false

	public init(layout: Layout = .sections, grouping: Grouping = .byTime, showsFilterChips: Bool = false) {
		self.layout = layout
		self.grouping = grouping
		self.showsFilterChips = showsFilterChips
	}

	public static let `default` = TeamDisplayOptions()
	public var isDefault: Bool { self == .default }
}

public enum TeamFilterChip: String, CaseIterable, Sendable, Codable {
	case all, unread, pinned, people, agents, groups, flows

	public var label: String {
		switch self {
		case .all: "All"
		case .unread: "Unread"
		case .pinned: "Pinned"
		case .people: "People"
		case .agents: "Agents"
		case .groups: "Groups"
		case .flows: "Flows"
		}
	}
}

// MARK: - Layout

/// The Team list as rows, computed from plain values so every branch is tested without a view.
/// Pinned rows live only in the tiles (never also in UNREAD), unread rows live only in UNREAD
/// (never also in the time groups), so nothing appears twice. Person rows reuse `TeamPerson`.
public struct TeamLayout: Equatable, Sendable {
	public static let sectionCap = TeamSections.peopleCap

	public struct Input: Sendable {
		public var conversations: [ConversationSummary]
		public var flowRooms: [TeamFlowRoom]
		public var archived: [ConversationSummary]
		public var options: TeamDisplayOptions
		public var chip: TeamFilterChip
		public var query: String
		public var currentActorID: String?
		public var pinOrder: [String]
		public var pinnedFlowIDs: Set<String>
		/// Capped sections ("All 9 flows") the user has opened; their rows are not sliced.
		public var expandedSectionIDs: Set<String>
		/// Agents running right now: their conversations list under "Working".
		public var workingAgentIDs: Set<String>
		/// Conversations whose unread messages mention you; with a trailing question they need you.
		public var mentionedConversationIDs: Set<String>
		public var now: Date
		public var calendar: Calendar

		public init(
			conversations: [ConversationSummary], flowRooms: [TeamFlowRoom] = [],
			archived: [ConversationSummary] = [], options: TeamDisplayOptions = .default,
			chip: TeamFilterChip = .all, query: String = "", currentActorID: String? = nil,
			pinOrder: [String] = [], pinnedFlowIDs: Set<String> = [], expandedSectionIDs: Set<String> = [],
			workingAgentIDs: Set<String> = [], mentionedConversationIDs: Set<String> = [],
			now: Date = Date(), calendar: Calendar = .current
		) {
			self.conversations = conversations
			self.flowRooms = flowRooms
			self.archived = archived
			self.options = options
			self.chip = chip
			self.query = query
			self.currentActorID = currentActorID
			self.pinOrder = pinOrder
			self.pinnedFlowIDs = pinnedFlowIDs
			self.expandedSectionIDs = expandedSectionIDs
			self.workingAgentIDs = workingAgentIDs
			self.mentionedConversationIDs = mentionedConversationIDs
			self.now = now
			self.calendar = calendar
		}
	}

	public enum RowKind: Equatable, Sendable {
		case conversation(ConversationSummary)
		case person(TeamPerson)
		case flow(TeamFlowRoom)
	}

	public struct Row: Identifiable, Equatable, Sendable {
		public var id: String
		public var kind: RowKind
		public init(id: String, kind: RowKind) {
			self.id = id
			self.kind = kind
		}
		public var activityDate: Date? {
			switch kind {
			case .conversation(let c): c.activityDate
			case .person(let p): p.latest.activityDate
			case .flow(let f): f.lastActivity
			}
		}
		public var unreadCount: Int {
			switch kind {
			case .conversation(let c): c.unreadCount
			case .person(let p): p.unreadCount
			case .flow(let f): f.unreadCount
			}
		}
		public var isUnread: Bool { unreadCount > 0 }
	}

	public struct Tile: Identifiable, Equatable, Sendable {
		public enum Kind: Equatable, Sendable {
			case conversation(ConversationSummary)
			case flow(TeamFlowRoom)
		}
		/// The pin key: a conversation id, or `flow:<id>`.
		public var id: String
		public var kind: Kind
		public var title: String
		public var subtitle: String
		public var unreadCount: Int
		public init(id: String, kind: Kind, title: String, subtitle: String, unreadCount: Int) {
			self.id = id
			self.kind = kind
			self.title = title
			self.subtitle = subtitle
			self.unreadCount = unreadCount
		}
	}

	public struct Section: Identifiable, Equatable, Sendable {
		public enum Kind: Equatable, Sendable { case working, unread, flows, people, time, all, filtered }
		public var id: String
		public var kind: Kind
		public var label: String
		public var count: Int
		public var rows: [Row]
		public var showsMarkAllRead = false
		/// "All 9 flows" when the section is capped and the rest can be shown.
		public var moreLabel: String?
		/// The section is open past its cap, so the footer reads "Show fewer".
		public var canCollapse = false
		public init(
			id: String, kind: Kind, label: String, count: Int, rows: [Row], showsMarkAllRead: Bool = false,
			moreLabel: String? = nil, canCollapse: Bool = false
		) {
			self.id = id
			self.kind = kind
			self.label = label
			self.count = count
			self.rows = rows
			self.showsMarkAllRead = showsMarkAllRead
			self.moreLabel = moreLabel
			self.canCollapse = canCollapse
		}
		/// The conversations behind the section, for "Mark all read".
		public var unreadConversationIDs: [String] {
			rows.flatMap { row -> [String] in
				switch row.kind {
				case .conversation(let c): c.isUnread ? [c.id] : []
				case .person(let p): p.conversations.filter(\.isUnread).map(\.id)
				case .flow: []
				}
			}
		}
	}

	public enum Empty: Equatable, Sendable {
		case nothing
		case noResults(String)
		case caughtUp
		case noKind(TeamFilterChip)

		public var title: String {
			switch self {
			case .nothing: "No conversations yet"
			case .noResults(let q): "No results for “\(q)”"
			case .caughtUp: "You're all caught up"
			case .noKind(.groups): "No group chats yet"
			case .noKind(let chip): "No \(chip.label.lowercased()) here yet"
			}
		}
		public var message: String {
			switch self {
			case .nothing: "Ask your Chief of Staff to get started, or message a teammate."
			case .noResults: "Check the spelling, or search everything in Maskin."
			case .caughtUp: "Nothing unread. New messages show up here first."
			case .noKind(.groups): "Start one from New conversation by adding two or more people."
			case .noKind: "They'll show up here once you have some."
			}
		}
		public var action: String {
			switch self {
			case .nothing: "New conversation"
			case .noResults: "Search all of Maskin"
			case .caughtUp, .noKind: "Show all"
			}
		}
	}

	public var tiles: [Tile]
	public var sections: [Section]
	public var archivedCount: Int
	/// Hidden while filtering, and when nothing is archived. A search keeps it only when an
	/// archived conversation matches, so archived chats can be found.
	public var showsArchived: Bool
	/// The archived conversations that match the search, newest first as loaded. Empty without a
	/// query, and while a filter chip is on.
	public var archivedMatches: [ConversationSummary] = []
	public var empty: Empty?
	/// Unread rows across the list (the Unread chip's count), pinned ones included.
	public var unreadCount: Int
	public var isFiltering: Bool

	/// Every conversation id the layout shows, in order, for selection mode.
	public var conversationIDs: [String] {
		var ids: [String] = []
		for tile in tiles { if case .conversation(let c) = tile.kind { ids.append(c.id) } }
		for section in sections {
			for row in section.rows {
				switch row.kind {
				case .conversation(let c): ids.append(c.id)
				case .person(let p): ids += p.conversations.map(\.id)
				case .flow: break
				}
			}
		}
		return ids
	}

	public static func flowPinKey(_ id: String) -> String { "flow:\(id)" }

	// MARK: Build

	public static func build(_ input: Input) -> TeamLayout {
		let query = input.query.trimmingCharacters(in: .whitespacesAndNewlines)
		let isFiltering = !query.isEmpty || input.chip != .all
		let pinnedFlowKeys = Set(input.pinnedFlowIDs.map(flowPinKey))
		let active = input.conversations.filter { !$0.archived }
		let me = input.currentActorID

		// Pinned tiles, in the persisted order, then by recency for anything not yet ordered.
		var tiles: [Tile] = active.filter(\.pinned).map { c in
			Tile(
				id: c.id, kind: .conversation(c), title: tileTitle(c, me: me),
				subtitle: ChatPreviewText.plain(c.title), unreadCount: c.unreadCount)
		}
		tiles += input.flowRooms.filter { pinnedFlowKeys.contains($0.pinKey) }.map { f in
			Tile(id: f.pinKey, kind: .flow(f), title: f.name, subtitle: "Flow", unreadCount: f.unreadCount)
		}
		tiles = order(tiles, by: input.pinOrder) { $0.id } recency: { tile in
			switch tile.kind {
			case .conversation(let c): c.activityDate
			case .flow(let f): f.lastActivity
			}
		}
		tiles = tiles.filter { tile in
			guard matches(tile, query: query) else { return false }
			switch input.chip {
			case .all: return true
			case .unread: return tile.unreadCount > 0
			// The Pinned chip lists the pinned chats as rows (below), not as tiles above them.
			case .groups, .pinned: return false
			case .flows: if case .flow = tile.kind { return true } else { return false }
			case .people, .agents:
				guard case .conversation(let c) = tile.kind else { return false }
				return kind(of: c, me: me) == (input.chip == .people ? .person : .agent)
			}
		}

		let unpinned = active.filter { !$0.pinned }
		let flows = input.flowRooms.filter { !pinnedFlowKeys.contains($0.pinKey) }
		// The Unread chip counts unread rows, not messages, and never the pinned tiles (they have their own badge).
		let totalUnread = unpinned.filter { $0.unreadCount > 0 }.count + flows.filter { $0.unreadCount > 0 }.count

		var sections: [Section]
		switch input.chip {
		case .all:
			sections =
				input.options.layout == .oneList
				? oneList(unpinned, flows: flows)
				: sectioned(unpinned, flows: flows, input: input, isFiltering: isFiltering)
		case .unread:
			let rows = (unpinned.map(conversationRow) + flows.map(flowRow)).filter(\.isUnread)
			sections = [
				Section(
					id: "unread", kind: .unread, label: "Unread", count: rows.count, rows: byRecency(rows),
					showsMarkAllRead: !rows.isEmpty)
			]
		case .pinned:
			let rows = byRecency(
				active.filter(\.pinned).map(conversationRow)
					+ input.flowRooms.filter { pinnedFlowKeys.contains($0.pinKey) }.map(flowRow))
			sections = [Section(id: "pinned", kind: .filtered, label: "Pinned", count: rows.count, rows: rows)]
		case .people, .agents:
			let wanted: ParticipantKind = input.chip == .people ? .person : .agent
			let rows = personRows(unpinned.filter { kind(of: $0, me: me) == wanted }, me: me)
			sections = [
				Section(id: "kind", kind: .filtered, label: input.chip.label, count: rows.count, rows: rows)
			]
		case .groups:
			sections = timeSections(unpinned.filter { kind(of: $0, me: me) == .group }, input: input)
		case .flows:
			let rows = byRecency(flows.map(flowRow))
			sections = [Section(id: "flows", kind: .flows, label: "Flows", count: rows.count, rows: rows)]
		}
		if !query.isEmpty {
			sections = sections.map { section in
				var s = section
				s.rows = section.rows.filter { matches($0, query: query) }
				s.count = s.rows.count
				s.moreLabel = nil
				return s
			}
		}
		sections = sections.filter { !$0.rows.isEmpty }

		let archivedMatches =
			!query.isEmpty && input.chip == .all ? input.archived.filter { matches($0, query: query) } : []
		let hasAny = !tiles.isEmpty || !sections.isEmpty || !archivedMatches.isEmpty
		let empty: Empty?
		if hasAny {
			empty = nil
		} else if !query.isEmpty {
			empty = .noResults(query)
		} else if input.chip == .unread {
			empty = .caughtUp
		} else if input.chip != .all {
			empty = .noKind(input.chip)
		} else {
			empty = .nothing
		}
		return TeamLayout(
			tiles: tiles, sections: sections, archivedCount: input.archived.count,
			showsArchived: (!isFiltering && !input.archived.isEmpty) || !archivedMatches.isEmpty,
			archivedMatches: archivedMatches, empty: empty,
			unreadCount: totalUnread, isFiltering: isFiltering)
	}

	// MARK: Sections layout

	private static func sectioned(
		_ conversations: [ConversationSummary], flows: [TeamFlowRoom], input: Input, isFiltering: Bool
	) -> [Section] {
		var sections: [Section] = []
		let me = input.currentActorID

		// WORKING first: each conversation lives in the first section it fits, so it never repeats
		// below in UNREAD or the time groups. An unread chat is not "needing you" on its own.
		let working = conversations.filter { isWorking($0, workingAgentIDs: input.workingAgentIDs) }
		let placed = Set(working.map(\.id))
		let conversations = conversations.filter { !placed.contains($0.id) }
		if !working.isEmpty {
			sections.append(
				Section(
					id: "working", kind: .working, label: "Working", count: working.count,
					rows: byRecency(working.map(conversationRow))))
		}

		// UNREAD: conversations (or people, when grouping by person) and flows with unread.
		let unreadConversations = conversations.filter(\.isUnread)
		let unreadRows: [Row]
		switch input.options.grouping {
		case .byPerson: unreadRows = personRows(unreadConversations, me: me)
		case .byTime, .newestFirst: unreadRows = unreadConversations.map(conversationRow)
		}
		let unread = byRecency(unreadRows + flows.filter { $0.unreadCount > 0 }.map(flowRow))
		if !unread.isEmpty {
			sections.append(
				Section(
					id: "unread", kind: .unread, label: "Unread", count: unread.count, rows: unread,
					showsMarkAllRead: true))
		}

		// FLOWS: the rest of the flows, capped unless filtering or opened.
		let restFlows = byRecency(flows.filter { $0.unreadCount == 0 }.map(flowRow))
		if !restFlows.isEmpty {
			let open = isFiltering || input.expandedSectionIDs.contains("flows")
			let capped = open ? restFlows : Array(restFlows.prefix(sectionCap))
			sections.append(
				Section(
					id: "flows", kind: .flows, label: "Flows", count: restFlows.count, rows: capped,
					moreLabel: capped.count < restFlows.count ? "All \(restFlows.count) flows" : nil,
					canCollapse: !isFiltering && open && restFlows.count > sectionCap))
		}

		// Everything read, by the chosen grouping.
		let read = conversations.filter { !$0.isUnread }
		switch input.options.grouping {
		case .byTime:
			sections += timeSections(read, input: input)
		case .byPerson:
			let rows = personRows(read, me: me)
			if !rows.isEmpty {
				let open = isFiltering || input.expandedSectionIDs.contains("people")
				let capped = open ? rows : Array(rows.prefix(sectionCap))
				sections.append(
					Section(
						id: "people", kind: .people, label: "People", count: rows.count, rows: capped,
						moreLabel: capped.count < rows.count ? "All \(rows.count) people & agents" : nil,
						canCollapse: !isFiltering && open && rows.count > sectionCap))
			}
		case .newestFirst:
			let rows = byRecency(read.map(conversationRow))
			if !rows.isEmpty {
				let open = isFiltering || input.expandedSectionIDs.contains("people")
				let capped = open ? rows : Array(rows.prefix(sectionCap))
				sections.append(
					Section(
						id: "people", kind: .people, label: "Conversations", count: rows.count, rows: capped,
						moreLabel: capped.count < rows.count ? "All \(rows.count) conversations" : nil,
						canCollapse: !isFiltering && open && rows.count > sectionCap))
			}
		}
		return sections
	}

	/// An agent in the conversation is running right now.
	public static func isWorking(_ c: ConversationSummary, workingAgentIDs: Set<String>) -> Bool {
		c.participants.contains { $0.kind == .agent && workingAgentIDs.contains($0.id) }
	}

	/// One list: an ALL card mixing flows and conversations, newest first.
	private static func oneList(_ conversations: [ConversationSummary], flows: [TeamFlowRoom]) -> [Section] {
		let rows = byRecency(conversations.map(conversationRow) + flows.map(flowRow))
		guard !rows.isEmpty else { return [] }
		return [
			Section(
				id: "all", kind: .all, label: "All", count: rows.count, rows: rows,
				showsMarkAllRead: rows.contains(where: \.isUnread))
		]
	}

	/// Today, Yesterday, This week, Last week, then months: `ConversationGrouping` owns the maths.
	private static func timeSections(_ conversations: [ConversationSummary], input: Input) -> [Section] {
		ConversationGrouping.group(conversations.map { var c = $0; c.pinned = false; return c }, now: input.now, calendar: input.calendar)
			.map { group in
				Section(
					id: "time-\(group.key.rawValue)", kind: .time, label: group.label, count: group.items.count,
					rows: group.items.map(conversationRow))
			}
	}

	// MARK: Rows

	public enum ParticipantKind: Equatable, Sendable { case person, agent, group }

	/// A group is more than one other party; otherwise the row is a person or an agent.
	public static func kind(of conversation: ConversationSummary, me: String?) -> ParticipantKind {
		if conversation.isGroupChat(excluding: me) { return .group }
		if conversation.others(excluding: me).contains(where: { $0.kind == .agent }) { return .agent }
		return .person
	}

	/// "{n} people · {first names}" for a group row's second line.
	public static func groupLine(_ conversation: ConversationSummary, me: String?) -> String {
		let rest = conversation.others(excluding: me)
		let names = rest.prefix(3).map { firstName($0.name) }
		let extra = rest.count - names.count
		return "\(conversation.participants.count) people · \(names.joined(separator: ", "))"
			+ (extra > 0 ? " +\(extra)" : "")
	}

	public static func firstName(_ name: String) -> String {
		name.split(separator: " ").first.map(String.init) ?? name
	}

	/// A 1:1 row is named after the other party; a group after its title.
	public static func title(of conversation: ConversationSummary, me: String?) -> String {
		if conversation.isGroupChat(excluding: me) { return ChatPreviewText.plain(conversation.title) }
		return conversation.others(excluding: me).first?.name ?? ChatPreviewText.plain(conversation.title)
	}

	private static func tileTitle(_ c: ConversationSummary, me: String?) -> String { title(of: c, me: me) }

	private static func conversationRow(_ c: ConversationSummary) -> Row { Row(id: c.id, kind: .conversation(c)) }
	private static func flowRow(_ f: TeamFlowRoom) -> Row { Row(id: f.pinKey, kind: .flow(f)) }

	/// One row per other participant (humans first, then agents, each by recency); a group chat is
	/// a conversation row of its own after them.
	static func personRows(_ conversations: [ConversationSummary], me: String?) -> [Row] {
		let people = ConversationGrouping.people(conversations, currentActorID: me)
		func rows(_ kind: TeamPerson.Kind) -> [Row] {
			byRecency(people.filter { $0.kind == kind }.map { Row(id: "person:\($0.id)", kind: .person($0)) })
		}
		let groups = byRecency(people.filter { $0.kind == .group }.map { conversationRow($0.latest) })
		return rows(.human) + rows(.agent) + groups
	}

	private static func byRecency(_ rows: [Row]) -> [Row] {
		rows.sorted { ($0.activityDate ?? .distantPast) > ($1.activityDate ?? .distantPast) }
	}

	private static func order<T>(
		_ items: [T], by keys: [String], id: (T) -> String, recency: (T) -> Date?
	) -> [T] {
		let index = Dictionary(keys.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
		return items.sorted { a, b in
			let ia = index[id(a)] ?? Int.max, ib = index[id(b)] ?? Int.max
			if ia != ib { return ia < ib }
			return (recency(a) ?? .distantPast) > (recency(b) ?? .distantPast)
		}
	}

	// MARK: Search

	private static func matches(_ row: Row, query: String) -> Bool {
		switch row.kind {
		case .conversation(let c): return matches(c, query: query)
		case .person(let p):
			return p.name.localizedCaseInsensitiveContains(query)
				|| p.conversations.contains { matches($0, query: query) }
		case .flow(let f):
			return f.name.localizedCaseInsensitiveContains(query)
				|| (f.lastPostText?.localizedCaseInsensitiveContains(query) ?? false)
				|| (f.lastPostAuthor?.localizedCaseInsensitiveContains(query) ?? false)
		}
	}

	private static func matches(_ tile: Tile, query: String) -> Bool {
		guard !query.isEmpty else { return true }
		switch tile.kind {
		case .conversation(let c): return matches(c, query: query)
		case .flow(let f): return f.name.localizedCaseInsensitiveContains(query)
		}
	}

	private static func matches(_ c: ConversationSummary, query: String) -> Bool {
		!ConversationGrouping.filter([c], query: query).isEmpty
	}
}

// MARK: - New conversation copy

public enum NewConversationCopy {
	/// "Message Sam and Chief of Staff", "Message Sam, Chief of Staff +2": first names for people,
	/// full names for agents, "A and B" for two, "+n" after two. "Pick someone first" with nobody.
	public static func placeholder(for recipients: [ChatParticipant]) -> String {
		guard !recipients.isEmpty else { return "Pick someone first" }
		let names = recipients.map { $0.kind == .agent ? $0.name : TeamLayout.firstName($0.name) }
		if names.count <= 2 { return "Message " + names.joined(separator: " and ") }
		return "Message \(names.prefix(2).joined(separator: ", ")) +\(names.count - 2)"
	}

	/// Shown with two or more recipients.
	public static func groupNote(recipientCount: Int) -> String? {
		guard recipientCount >= 2 else { return nil }
		return "\(recipientCount + 1) in this conversation, including you. Everyone sees the whole thread."
	}

	/// Candidates for the To field, matched on name and role.
	public static func matches(_ query: String, in actors: [ChatActor], excluding: Set<String>) -> [ChatActor] {
		let q = query.trimmingCharacters(in: .whitespaces)
		return actors.filter { actor in
			guard !excluding.contains(actor.id) else { return false }
			if q.isEmpty { return true }
			return actor.participant.name.localizedCaseInsensitiveContains(q)
				|| (actor.summary?.localizedCaseInsensitiveContains(q) ?? false)
				|| role(of: actor).localizedCaseInsensitiveContains(q)
		}
	}

	/// The second line of a picker row: an agent's role from its summary, otherwise its kind.
	public static func role(of actor: ChatActor) -> String {
		if actor.participant.kind == .human { return "Person" }
		let summary = actor.summary?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		return summary.isEmpty ? "Agent" : ChatPreviewText.firstClause(summary)
	}
}

// MARK: - Preferences

/// Per-user Team settings (display options, pin order, locally pinned flows), keyed by actor and
/// workspace so two accounts on one device never share them.
public struct TeamPreferences: Sendable {
	private let defaults: UserDefaultsBox
	private let scope: String

	public init(defaults: UserDefaults = .standard, actorID: String?, workspaceID: String) {
		self.defaults = UserDefaultsBox(defaults)
		self.scope = "team.v1.\(actorID ?? "anon").\(workspaceID)"
	}

	public var displayOptions: TeamDisplayOptions {
		get {
			guard let data = defaults.value.data(forKey: "\(scope).display"),
				let saved = try? JSONDecoder().decode(TeamDisplayOptions.self, from: data)
			else { return .default }
			return saved
		}
		nonmutating set {
			defaults.value.set(try? JSONEncoder().encode(newValue), forKey: "\(scope).display")
		}
	}

	public var pinOrder: [String] {
		get { defaults.value.stringArray(forKey: "\(scope).pinOrder") ?? [] }
		nonmutating set { defaults.value.set(newValue, forKey: "\(scope).pinOrder") }
	}

	/// Flows have no server-side pin yet, so a pinned flow is remembered here.
	public var pinnedFlowIDs: Set<String> {
		get { Set(defaults.value.stringArray(forKey: "\(scope).pinnedFlows") ?? []) }
		nonmutating set { defaults.value.set(Array(newValue).sorted(), forKey: "\(scope).pinnedFlows") }
	}
}

/// `UserDefaults` is thread-safe but not `Sendable` on every SDK.
private struct UserDefaultsBox: @unchecked Sendable {
	let value: UserDefaults
	init(_ value: UserDefaults) { self.value = value }
}
