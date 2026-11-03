import Foundation
import Testing

@testable import MaskinCore

private var cal: Calendar {
	var c = Calendar(identifier: .gregorian)
	c.timeZone = TimeZone(secondsFromGMT: 0)!
	return c
}

/// Noon UTC on a fixed day.
private let now = Date(timeIntervalSince1970: Double(1_790_000_000 - 1_790_000_000 % 86_400 + 12 * 3600))

private func ago(hours: Double) -> Date { now.addingTimeInterval(-hours * 3600) }

private let ida = ChatParticipant(id: "ida", name: "Ida Berg", kind: .human)
private let forge = ChatParticipant(id: "forge", name: "Forge", kind: .agent)

private func flow(_ id: String, name: String? = nil, hoursAgo: Double = 1, unread: Int = 0, working: Int = 0) -> TeamFlowRoom {
	TeamFlowRoom(
		id: id, name: name ?? "Flow \(id)", lastPostAuthor: "Relay", lastPostText: "Shipped the fix. Next up: tests.",
		lastActivity: ago(hours: hoursAgo), workingCount: working, unreadCount: unread)
}

private func build(
	_ conversations: [ConversationSummary], flows: [TeamFlowRoom] = [], archived: [ConversationSummary] = [],
	options: TeamDisplayOptions = .default, chip: TeamFilterChip = .all, query: String = "",
	pinOrder: [String] = [], pinnedFlows: Set<String> = [], expanded: Set<String> = []
) -> TeamLayout {
	TeamLayout.build(
		TeamLayout.Input(
			conversations: conversations, flowRooms: flows, archived: archived, options: options, chip: chip,
			query: query, currentActorID: "me", pinOrder: pinOrder, pinnedFlowIDs: pinnedFlows,
			expandedSectionIDs: expanded, now: now, calendar: cal))
}

private extension TeamLayout {
	func section(_ id: String) -> TeamLayout.Section? { sections.first { $0.id == id } }
	func rowIDs(_ id: String) -> [String] { section(id)?.rows.map(\.id) ?? [] }
}

@Suite("TeamLayout")
struct TeamLayoutTests {
	@Test("pinned rows live only in the tiles, unread rows only in UNREAD, the rest by time")
	func sections() {
		let layout = build([
			chatConvo("pin", last: ago(hours: 1), pinned: true, unread: 2),
			chatConvo("un", last: ago(hours: 2), unread: 1),
			chatConvo("read", last: ago(hours: 3)),
			chatConvo("old", last: ago(hours: 60)),
		])
		#expect(layout.tiles.map(\.id) == ["pin"])
		#expect(layout.rowIDs("unread") == ["un"])
		#expect(layout.section("unread")?.showsMarkAllRead == true)
		#expect(layout.section("unread")?.count == 1)
		#expect(layout.sections.map(\.kind) == [.unread, .time, .time])
		#expect(layout.sections.dropFirst().flatMap { $0.rows.map(\.id) } == ["read", "old"])
		#expect(layout.unreadCount == 1, "the chip counts unread rows that are not pinned")
		#expect(layout.empty == nil)
		#expect(layout.showsArchived == false)
	}

	@Test("flows: unread ones in UNREAD, the rest capped at five with an All-n row, uncapped once expanded")
	func flows() {
		let flows = (1...7).map { flow("f\($0)", hoursAgo: Double($0)) } + [flow("hot", hoursAgo: 0.5, unread: 3)]
		let layout = build([chatConvo("a", last: ago(hours: 2))], flows: flows)
		#expect(layout.rowIDs("unread") == ["flow:hot"])
		#expect(layout.section("flows")?.rows.count == TeamLayout.sectionCap)
		#expect(layout.section("flows")?.count == 7)
		#expect(layout.section("flows")?.moreLabel == "All 7 flows")
		#expect(layout.rowIDs("flows").first == "flow:f1", "newest flow first")

		let open = build([chatConvo("a")], flows: flows, expanded: ["flows"])
		#expect(open.section("flows")?.rows.count == 7)
		#expect(open.section("flows")?.moreLabel == nil)
	}

	@Test("by person: one row per person, humans before agents, their conversations newest first")
	func byPerson() {
		let rows = [
			chatConvo("r1", last: ago(hours: 5), participants: [chatMe, chatRelay]),
			chatConvo("r2", last: ago(hours: 1), participants: [chatMe, chatRelay]),
			chatConvo("i1", last: ago(hours: 9), participants: [chatMe, ida]),
			chatConvo("g1", title: "Launch", last: ago(hours: 2), participants: [chatMe, ida, forge]),
		]
		let layout = build(rows, options: TeamDisplayOptions(grouping: .byPerson))
		let people = layout.section("people")
		#expect(people?.rows.map(\.id) == ["person:ida", "person:relay", "g1"])
		guard case .person(let relay)? = people?.rows.first(where: { $0.id == "person:relay" })?.kind else {
			Issue.record("no relay row")
			return
		}
		#expect(relay.conversations.map(\.id) == ["r2", "r1"])
		#expect(relay.latest.id == "r2")
		#expect(relay.hasSeveral)
		#expect(TeamLayout.kind(of: rows[3], me: "me") == .group)
		#expect(TeamLayout.groupLine(rows[3], me: "me") == "3 people · Ida, Forge")
	}

	@Test("by person: six people cap at five with an All-n row")
	func peopleCap() {
		let rows = (1...6).map { i in
			chatConvo("c\(i)", last: ago(hours: Double(i)), participants: [chatMe, ChatParticipant(id: "p\(i)", name: "P \(i)", kind: .human)])
		}
		let layout = build(rows, options: TeamDisplayOptions(grouping: .byPerson))
		#expect(layout.section("people")?.rows.count == 5)
		#expect(layout.section("people")?.moreLabel == "All 6 people & agents")
	}

	@Test("newest first caps at five with an All-n conversations row, and shows fewer once opened")
	func newestFirstCap() {
		let rows = (1...7).map { chatConvo("c\($0)", last: ago(hours: Double($0))) }
		let options = TeamDisplayOptions(grouping: .newestFirst)
		let capped = build(rows, options: options)
		#expect(capped.section("people")?.rows.count == 5)
		#expect(capped.section("people")?.moreLabel == "All 7 conversations")
		#expect(capped.section("people")?.canCollapse == false)
		let open = build(rows, options: options, expanded: ["people"])
		#expect(open.section("people")?.rows.count == 7)
		#expect(open.section("people")?.canCollapse == true)
	}

	@Test("newest first: every read conversation on its own row, in one section")
	func newestFirst() {
		let layout = build(
			[chatConvo("a", last: ago(hours: 3)), chatConvo("b", last: ago(hours: 1)), chatConvo("u", last: ago(hours: 2), unread: 1)],
			options: TeamDisplayOptions(grouping: .newestFirst))
		#expect(layout.sections.map(\.id) == ["unread", "people"])
		#expect(layout.rowIDs("people") == ["b", "a"])
	}

	@Test("one list: tiles, then one ALL card mixing flows and conversations newest first")
	func oneList() {
		let layout = build(
			[chatConvo("pin", last: ago(hours: 1), pinned: true), chatConvo("a", last: ago(hours: 3)), chatConvo("u", last: ago(hours: 1.5), unread: 1)],
			flows: [flow("f", hoursAgo: 2)], options: TeamDisplayOptions(layout: .oneList))
		#expect(layout.tiles.map(\.id) == ["pin"])
		#expect(layout.sections.map(\.id) == ["all"])
		#expect(layout.rowIDs("all") == ["u", "flow:f", "a"])
		#expect(layout.section("all")?.showsMarkAllRead == true)
		#expect(layout.section("all")?.label == "All")
	}

	@Test("tiles follow the saved order, then recency; pinned flows join them")
	func pinOrder() {
		let layout = build(
			[chatConvo("a", last: ago(hours: 1), pinned: true), chatConvo("b", last: ago(hours: 5), pinned: true), chatConvo("c", last: ago(hours: 3), pinned: true)],
			flows: [flow("f")], pinOrder: ["c", "flow:f"], pinnedFlows: ["f"])
		#expect(layout.tiles.map(\.id) == ["c", "flow:f", "a", "b"])
		#expect(layout.tiles[1].title == "Flow f")
		#expect(layout.tiles[1].subtitle == "Flow")
		#expect(layout.tiles[2].title == "Relay", "a 1:1 tile is named after the other person")
	}

	@Test("the Unread chip keeps only unread rows and says caught up when there are none")
	func unreadChip() {
		let some = build([chatConvo("a", unread: 1), chatConvo("b")], flows: [flow("f", unread: 1)], chip: .unread)
		#expect(some.sections.map(\.id) == ["unread"])
		#expect(Set(some.rowIDs("unread")) == ["a", "flow:f"])
		let none = build([chatConvo("b")], chip: .unread)
		#expect(none.sections.isEmpty)
		#expect(none.empty == .caughtUp)
		#expect(none.empty?.action == "Show all")
	}

	@Test("People and Agents chips list one row per person or agent; Groups only 3+ member chats; Flows unsliced")
	func kindChips() {
		let rows = [
			chatConvo("r1", participants: [chatMe, chatRelay]), chatConvo("r2", participants: [chatMe, chatRelay]),
			chatConvo("i1", participants: [chatMe, ida]), chatConvo("g1", participants: [chatMe, ida, forge]),
		]
		let flows = (1...7).map { flow("f\($0)", hoursAgo: Double($0)) }
		#expect(build(rows, chip: .people).sections.flatMap { $0.rows.map(\.id) } == ["person:ida"])
		#expect(build(rows, chip: .agents).sections.flatMap { $0.rows.map(\.id) } == ["person:relay"])
		let groups = build(rows, chip: .groups)
		#expect(groups.sections.map(\.kind) == [.time])
		#expect(groups.sections.flatMap { $0.rows.map(\.id) } == ["g1"])
		#expect(build(rows, flows: flows, chip: .flows).section("flows")?.rows.count == 7)
		#expect(build([], chip: .groups).empty == .noKind(.groups))
		#expect(build([], chip: .groups).empty?.title == "No group chats yet")
		#expect(build([], chip: .agents).empty?.title == "No agents here yet")
	}

	@Test("search filters every section by name and preview, drops the All-n rows and hides Archived")
	func search() {
		let flows = (1...7).map { flow("f\($0)", name: $0 == 3 ? "Roadmap" : nil, hoursAgo: Double($0)) }
		let rows = [
			chatConvo("a", last: ago(hours: 1), snippet: "roadmap is ready"), chatConvo("b", last: ago(hours: 2)),
			chatConvo("p", last: ago(hours: 3), pinned: true, participants: [chatMe, ChatParticipant(id: "ro", name: "Roadie", kind: .human)]),
		]
		let layout = build(rows, flows: flows, archived: [chatConvo("z")], query: "road")
		#expect(layout.tiles.map(\.id) == ["p"])
		#expect(layout.rowIDs("flows") == ["flow:f3"])
		#expect(layout.section("flows")?.moreLabel == nil)
		#expect(layout.sections.filter { $0.kind == .time }.flatMap { $0.rows.map(\.id) } == ["a"])
		#expect(layout.showsArchived == false)
		#expect(layout.isFiltering)

		let none = build(rows, query: "zzz")
		#expect(none.empty == .noResults("zzz"))
		#expect(none.empty?.title == "No results for “zzz”")
		#expect(none.empty?.action == "Search all of Maskin")
	}

	@Test("a search also finds archived chats, keeps the Archived row for them and is not a dead end")
	func searchFindsArchived() {
		let archived = [
			chatConvo("old", title: "Roadmap 2025", last: ago(hours: 900)),
			chatConvo("other", title: "Budget", last: ago(hours: 800)),
		]
		let found = build([chatConvo("a")], archived: archived, query: "road")
		#expect(found.archivedMatches.map(\.id) == ["old"])
		#expect(found.showsArchived)
		#expect(found.archivedCount == 2)
		#expect(found.empty == nil, "an archived match is a result")
		#expect(found.sections.isEmpty)

		let miss = build([chatConvo("a")], archived: archived, query: "zzz")
		#expect(miss.archivedMatches.isEmpty)
		#expect(miss.showsArchived == false)
		#expect(miss.empty == .noResults("zzz"))

		let plain = build([chatConvo("a")], archived: archived)
		#expect(plain.archivedMatches.isEmpty, "no query, no matches list")
		#expect(plain.showsArchived)

		let chipped = build([chatConvo("a")], archived: archived, chip: .unread, query: "road")
		#expect(chipped.archivedMatches.isEmpty, "a filter chip leaves archived chats out")
	}

	@Test("nothing at all shows the first-run empty state; archived rows count and show when not filtering")
	func emptyAndArchived() {
		let nothing = build([])
		#expect(nothing.empty == .nothing)
		#expect(nothing.empty?.action == "New conversation")
		let archived = build([chatConvo("a")], archived: [chatConvo("x"), chatConvo("y")])
		#expect(archived.showsArchived)
		#expect(archived.archivedCount == 2)
		#expect(build([], archived: [chatConvo("x")]).empty == .nothing, "archived rows don't count as content")
	}

	@Test("row kinds: 3+ members is a group, an agent makes an agent row, otherwise a person")
	func kinds() {
		#expect(TeamLayout.kind(of: chatConvo("a", participants: [chatMe, chatRelay]), me: "me") == .agent)
		#expect(TeamLayout.kind(of: chatConvo("a", participants: [chatMe, ida]), me: "me") == .person)
		#expect(TeamLayout.kind(of: chatConvo("a", participants: [chatMe, ida, chatRelay]), me: "me") == .group)
		#expect(TeamLayout.title(of: chatConvo("a", participants: [chatMe, ida]), me: "me") == "Ida Berg")
		#expect(TeamLayout.title(of: chatConvo("g", title: "Launch", participants: [chatMe, ida, forge]), me: "me") == "Launch")
	}
}

@Suite("ConversationRowStatus")
struct ConversationRowStatusTests {
	private let convo = chatConvo("c", snippet: "Done. PR is **up**", participants: [chatMe, chatRelay])

	@Test("the plain preview is led by who wrote it")
	func plain() {
		var c = convo
		c.snippetActorName = "Relay"
		let status = ConversationRowStatus.make(conversation: c)
		#expect(status.prefix == nil)
		#expect(status.preview == "Relay: Done. PR is up")
		#expect(!status.isDraft)
	}

	@Test("typing replaces everything, a draft beats working, working beats the tick")
	func precedence() {
		let typing = ConversationRowStatus.make(conversation: convo, draft: "hi", typing: true, workingAgents: 2)
		#expect(typing.prefix == .typing)
		#expect(typing.preview == "")
		let draft = ConversationRowStatus.make(conversation: convo, draft: " hello ", workingAgents: 1)
		#expect(draft.prefix == nil)
		#expect(draft.preview == "Draft: hello")
		#expect(draft.isDraft)
		let working = ConversationRowStatus.make(conversation: convo, workingAgents: 2, tick: .sent)
		#expect(working.prefix == .working(2))
		#expect(working.preview == "Done. PR is up", "no author while working: the prefix carries the agent")
		#expect(ConversationRowStatus.workingLabel(1) == "Working")
		#expect(ConversationRowStatus.workingLabel(3) == "3 working")
	}

	@Test("your latest message reads You: …; a sending or failed one keeps its mark")
	func ticks() {
		var c = convo
		c.snippetActorName = "Me"
		#expect(ConversationRowStatus.make(conversation: c, tick: .sent).prefix == nil)
		#expect(ConversationRowStatus.make(conversation: c, tick: .sent).preview == "You: Done. PR is up")
		#expect(ConversationRowStatus.make(conversation: c, tick: .failed).prefix == .tick(.failed))
		#expect(ConversationRowStatus.make(conversation: c, tick: .failed).accessibilityText == "not sent, Done. PR is up")
		#expect(ConversationRowStatus.Tick.read.symbol == "✓✓")
		#expect(ConversationRowStatus.Tick.sending.symbol == "…")
	}

	@Test("the @ badge only shows while the conversation is unread; an empty snippet reads No messages yet")
	func mentionAndEmpty() {
		#expect(ConversationRowStatus.make(conversation: convo, mentionsYou: true).mentionsYou == false)
		#expect(ConversationRowStatus.make(conversation: chatConvo("u", unread: 1), mentionsYou: true).mentionsYou)
		let empty = ConversationRowStatus.make(conversation: chatConvo("e"))
		#expect(empty.preview == ConversationRowStatus.noMessages)
	}

	@Test("a flow row shows the author and the first clause of the last post")
	func flowStatus() {
		let room = TeamFlowRoom(id: "f", name: "Launch", lastPostAuthor: "Relay", lastPostText: "Shipped the fix. Next: tests.", workingCount: 2)
		let status = ConversationRowStatus.make(flow: room)
		#expect(status.prefix == .working(2))
		#expect(status.preview == "Relay: Shipped the fix")
		#expect(ConversationRowStatus.make(flow: TeamFlowRoom(id: "g", name: "Quiet")).preview == ConversationRowStatus.noMessages)
	}
}

@Suite("ChatPreviewText.firstClause")
struct FirstClauseTests {
	@Test("cuts at the first stop, keeps a text with none, never returns empty")
	func clauses() {
		#expect(ChatPreviewText.firstClause("Done. PR is up") == "Done")
		#expect(ChatPreviewText.firstClause("Blocked: waiting on legal; ping Sam") == "Blocked")
		#expect(ChatPreviewText.firstClause("One line only") == "One line only")
		#expect(ChatPreviewText.firstClause("First\nSecond") == "First")
		#expect(ChatPreviewText.firstClause("... trailing") == "... trailing")
	}
}

@Suite("NewConversationCopy")
struct NewConversationCopyTests {
	private let sam = ChatParticipant(id: "s", name: "Sam Berg", kind: .human)
	private let chief = ChatParticipant(id: "c", name: "Chief of Staff", kind: .agent)

	@Test("placeholder: first names for people, full names for agents, +n after two")
	func placeholder() {
		#expect(NewConversationCopy.placeholder(for: []) == "Pick someone first")
		#expect(NewConversationCopy.placeholder(for: [sam]) == "Message Sam")
		#expect(NewConversationCopy.placeholder(for: [sam, chief]) == "Message Sam and Chief of Staff")
		#expect(NewConversationCopy.placeholder(for: [sam, chief, ida, forge]) == "Message Sam, Chief of Staff +2")
	}

	@Test("the group note counts you in and only shows with two or more recipients")
	func note() {
		#expect(NewConversationCopy.groupNote(recipientCount: 1) == nil)
		#expect(NewConversationCopy.groupNote(recipientCount: 2) == "3 in this conversation, including you. Everyone sees the whole thread.")
	}

	@Test("matches search name and role, never someone already picked")
	func matching() {
		let actors = [
			ChatActor(participant: sam), ChatActor(participant: chief, summary: "Runs the daily briefing. Escalates blockers."),
			ChatActor(participant: ChatParticipant(id: "r", name: "Quill", kind: .agent), summary: "Researcher for market scans"),
		]
		#expect(NewConversationCopy.matches("research", in: actors, excluding: []).map(\.id) == ["r"])
		#expect(NewConversationCopy.matches("sam", in: actors, excluding: []).map(\.id) == ["s"])
		#expect(NewConversationCopy.matches("person", in: actors, excluding: []).map(\.id) == ["s"])
		#expect(NewConversationCopy.matches("", in: actors, excluding: ["s"]).map(\.id) == ["c", "r"])
		#expect(NewConversationCopy.role(of: actors[1]) == "Runs the daily briefing")
		#expect(NewConversationCopy.role(of: actors[0]) == "Person")
		#expect(NewConversationCopy.role(of: ChatActor(participant: forge)) == "Agent")
	}
}

@Suite("TeamPreferences")
struct TeamPreferencesTests {
	@Test("display options, pin order and pinned flows persist per actor and workspace")
	func persists() {
		let defaults = UserDefaults(suiteName: "TeamPreferencesTests.\(UUID().uuidString)")!
		let a = TeamPreferences(defaults: defaults, actorID: "a", workspaceID: "w")
		let b = TeamPreferences(defaults: defaults, actorID: "b", workspaceID: "w")
		#expect(a.displayOptions == .default)
		a.displayOptions = TeamDisplayOptions(layout: .oneList, showsFilterChips: true)
		a.pinOrder = ["x", "flow:f"]
		a.pinnedFlowIDs = ["f"]
		#expect(TeamPreferences(defaults: defaults, actorID: "a", workspaceID: "w").displayOptions.layout == .oneList)
		#expect(TeamPreferences(defaults: defaults, actorID: "a", workspaceID: "w").pinOrder == ["x", "flow:f"])
		#expect(TeamPreferences(defaults: defaults, actorID: "a", workspaceID: "w").pinnedFlowIDs == ["f"])
		#expect(b.displayOptions == .default)
		#expect(b.pinOrder.isEmpty)
	}
}

@Suite("TeamLayout needs you and working")
struct TeamLayoutPriorityTests {
	private func layout(
		_ conversations: [ConversationSummary], working: Set<String> = [], mentioned: Set<String> = []
	) -> TeamLayout {
		TeamLayout.build(
			TeamLayout.Input(
				conversations: conversations, currentActorID: "me", workingAgentIDs: working,
				mentionedConversationIDs: mentioned, now: now, calendar: cal))
	}

	@Test("an unread question or mention is plain Unread, never a Needs you section")
	func unreadIsNotNeedsYou() {
		let result = layout(
			[
				chatConvo("ask", last: ago(hours: 1), unread: 1, snippet: "Ship it today?", participants: [chatMe, forge]),
				chatConvo("ping", last: ago(hours: 2), unread: 1, snippet: "FYI", participants: [chatMe, forge]),
				chatConvo("read", last: ago(hours: 4), snippet: "Okay?", participants: [chatMe, forge]),
			], mentioned: ["ping"])
		#expect(result.sections.first?.kind == .unread)
		#expect(result.sections.first?.rows.map(\.id) == ["ask", "ping"])
		#expect(result.conversationIDs.filter { $0 == "ask" }.count == 1)
	}

	@Test("the Pinned chip lists pinned chats as rows and hides the tiles")
	func pinnedChip() {
		var pinned = chatConvo("pin", last: ago(hours: 1), participants: [chatMe, forge])
		pinned.pinned = true
		let other = chatConvo("other", last: ago(hours: 2), participants: [chatMe, ida])
		let result = TeamLayout.build(
			TeamLayout.Input(
				conversations: [pinned, other], chip: .pinned, currentActorID: "me", now: now, calendar: cal))
		#expect(result.tiles.isEmpty)
		#expect(result.sections.first?.rows.map(\.id) == ["pin"])
	}

	@Test("a conversation with a running agent lists under Working, after Needs you")
	func working() {
		let result = layout(
			[
				chatConvo("run", last: ago(hours: 5), participants: [chatMe, forge]),
				chatConvo("idle", last: ago(hours: 1), participants: [chatMe, ida]),
			], working: ["forge"])
		#expect(result.sections.map(\.kind) == [.working, .time])
		#expect(result.rowIDs("working") == ["run"])
	}
}

@Suite("ConversationRowStatus working text")
struct WorkingTextTests {
	private let convo = chatConvo("c", snippet: "Done", participants: [chatMe, chatRelay])

	@Test("one agent is named, two are joined, more fall back to a count")
	func names() {
		func text(_ names: [String]) -> String {
			ConversationRowStatus.make(conversation: convo, workingAgents: names.count, workingNames: names).workingText
		}
		#expect(text(["Forge"]) == "Forge is working")
		#expect(text(["Forge", "Ida"]) == "Forge and Ida are working")
		#expect(text(["Forge", "Ida", "Relay"]) == "3 working")
		#expect(ConversationRowStatus.make(conversation: convo, workingAgents: 1).workingText == "Working")
	}
}

@Suite("ConversationRowStatus links") struct ConversationRowStatusLinkTests {
	private func convo(_ snippet: String, who: String? = "Developer") -> ConversationSummary {
		ConversationSummary(id: "c", title: "t", snippet: snippet, snippetActorName: who)
	}

	@Test("the author lead is unchanged and a bare address reads link in a muted run")
	func bareAddressAfterLead() {
		let status = ConversationRowStatus.make(conversation: convo("https://maskin.io/ws/objects/abc"))
		#expect(status.preview == "Developer: link")
		#expect(
			status.previewPieces == [
				ChatPreviewText.Piece("Developer: "), ChatPreviewText.Piece("link", isLink: true),
			])
	}

	@Test("a cut link shows its words after the lead")
	func cutLinkAfterLead() {
		let status = ConversationRowStatus.make(conversation: convo("[Chat preview cards for every li"))
		#expect(status.preview == "Developer: Chat preview cards for every li")
		#expect(status.previewPieces == nil)
	}

	@Test("assigning a new preview drops the old runs")
	func assigningPreviewResetsRuns() {
		var status = ConversationRowStatus.make(conversation: convo("https://x.io/a"))
		status.preview = "2 conversations · Title"
		#expect(status.previewPieces == nil)
	}
}
