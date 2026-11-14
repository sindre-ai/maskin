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

private func room(
	_ id: String, kind: RoomKind, last: Date?, snippet: String? = "hello", unread: Int = 0,
	pinned: Bool = false, flowID: String? = nil
) -> ConversationSummary {
	var c = chatConvo(id, title: "Room \(id)", last: last, pinned: pinned, unread: unread, snippet: snippet)
	c.roomKind = kind
	c.flowID = flowID
	return c
}

private func build(
	_ conversations: [ConversationSummary], flows: [TeamFlowRoom] = [], chip: TeamFilterChip = .all,
	options: TeamDisplayOptions = TeamDisplayOptions(grouping: .byTime), query: String = ""
) -> TeamLayout {
	TeamLayout.build(
		TeamLayout.Input(
			conversations: conversations, flowRooms: flows, archived: [], options: options, chip: chip,
			query: query, currentActorID: "me", pinOrder: [], pinnedFlowIDs: [], expandedSectionIDs: [],
			now: now, calendar: cal))
}

@Suite("TeamLayout rooms")
struct TeamLayoutRoomsTests {
	@Test("rooms are the first section, each chat once, named after the room")
	func roomsFirst() {
		let layout = build([
			chatConvo("plain", last: ago(hours: 1)),
			room("w46", kind: .free, last: ago(hours: 200)),
		])
		#expect(layout.sections.map(\.id).first == "rooms")
		#expect(layout.sections.first?.kind == .rooms)
		#expect(layout.sections.first?.label == "Rooms")
		#expect(layout.sections.first?.rows.map(\.id) == ["w46"])
		let others = layout.sections.dropFirst().flatMap { $0.rows.map(\.id) }
		#expect(others == ["plain"])
		let title = TeamLayout.displayedTitle(of: layout.sections[0].rows[0].kind, me: "me")
		#expect(title == "Room w46", "a room keeps its own name instead of the other person's")
	}

	@Test("a room a person made is never dropped for being quiet")
	func freeRoomAlwaysShows() {
		let layout = build([room("old", kind: .free, last: ago(hours: 24 * 400), snippet: nil)])
		#expect(layout.sections.first?.rows.map(\.id) == ["old"])
	}

	@Test("a flow's room shows with a message in 14 days, unread, or working; empty or quiet ones are hidden")
	func flowRoomVisibility() {
		let recent = room("recent", kind: .flow, last: ago(hours: 24 * 13))
		let quiet = room("quiet", kind: .flow, last: ago(hours: 24 * 15))
		let unread = room("unread", kind: .flow, last: ago(hours: 24 * 60), unread: 2)
		let empty = room("empty", kind: .flow, last: ago(hours: 1), snippet: nil)
		let layout = build([recent, quiet, unread, empty])
		let ids = layout.sections.flatMap { $0.rows.map(\.id) }
		#expect(Set(ids) == ["recent", "unread"])
	}

	@Test("a search still finds a flow's room that the list hides")
	func searchFindsHiddenRoom() {
		let quiet = room("quiet", kind: .flow, last: ago(hours: 24 * 90))
		#expect(build([quiet]).sections.isEmpty)
		let found = build([quiet], query: "Room quiet")
		#expect(found.sections.flatMap { $0.rows.map(\.id) } == ["quiet"])
	}

	@Test("a flow that has a room is that room's row, not a second Flows row")
	func flowWithRoomIsNotRepeated() {
		let flows = [
			TeamFlowRoom(id: "f1", name: "Weekly review", lastActivity: ago(hours: 2)),
			TeamFlowRoom(id: "f2", name: "Other flow", lastActivity: ago(hours: 3)),
		]
		let layout = build([room("c1", kind: .flow, last: ago(hours: 2), flowID: "f1")], flows: flows)
		#expect(layout.sections.first?.rows.map(\.id) == ["c1"])
		let flowRows = layout.sections.first { $0.kind == .flows }?.rows.map(\.id)
		#expect(flowRows == [TeamLayout.flowPinKey("f2")])
	}

	@Test("a room never folds into a person row")
	func roomsStayOutOfPeopleChips() {
		let layout = build([room("r", kind: .free, last: ago(hours: 1))], chip: .agents)
		#expect(layout.sections.flatMap(\.rows).isEmpty)
		let all = build([room("r", kind: .free, last: ago(hours: 1))], options: TeamDisplayOptions(layout: .sections, grouping: .byPerson))
		#expect(all.sections.first?.rows.map(\.id) == ["r"])
	}

	@Test("the Flows chip lists a flow's room next to flows that have none")
	func flowsChip() {
		let layout = build(
			[room("c1", kind: .flow, last: ago(hours: 2), flowID: "f1")],
			flows: [TeamFlowRoom(id: "f1", name: "Weekly review"), TeamFlowRoom(id: "f2", name: "Other")],
			chip: .flows)
		let ids = layout.sections.flatMap { $0.rows.map(\.id) }
		#expect(Set(ids) == ["c1", TeamLayout.flowPinKey("f2")])
	}
}
