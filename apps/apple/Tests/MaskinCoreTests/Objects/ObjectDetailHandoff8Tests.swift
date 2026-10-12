import Foundation
import Testing

@testable import MaskinCore

@MainActor
private func makeStore(objectId: String = "t1") -> (ObjectDetailStore, FakeObjectsRemote) {
	let remote = FakeObjectsRemote(objects: Fixtures.objects)
	let object = Fixtures.objects.first { $0.id == objectId }!
	remote.setGraph(Fixtures.graph(for: object))
	let directory = ObjectsDirectory(remote: remote, actors: Fixtures.actors)
	return (
		ObjectDetailStore(
			objectId: objectId, remote: remote, directory: directory, currentActorId: "me", preload: object),
		remote
	)
}

@MainActor
@Suite("Object detail (handoff 8)")
struct ObjectDetailHandoff8Tests {
	@Test("archive stays on the page, flags it archived, and Unarchive returns to where it was")
	func archiveRoundTrip() async {
		let (store, _) = makeStore()
		await store.load()
		#expect(!store.isArchived)
		#expect(await store.archive())
		#expect(store.isArchived)
		#expect(store.object?.status == "discarded")
		await store.unarchive()
		#expect(!store.isArchived)
		#expect(store.object?.status == "in_progress")
	}

	@Test("Unarchive on an object opened already archived lands on the first live status")
	func unarchiveFromScratch() async {
		let (store, _) = makeStore()
		await store.load()
		await store.setStatus("discarded")
		await store.unarchive()
		#expect(store.object?.status == "backlog")
	}

	@Test("a refused driver change puts the old driver back")
	func driverRollback() async {
		let (store, remote) = makeStore()
		await store.load()
		remote.fail("update")
		await store.edit(ObjectPatch(driver: "sigrid"))
		#expect(store.object?.driverId == "forge")
		#expect(store.actionError != nil)
	}

	@Test("assignees list agents first, then people, each by name")
	func assignees() async {
		let (store, _) = makeStore()
		await store.load()
		#expect(store.assignees.map(\.name) == ["Forge", "Alex Preview", "Sigrid Larsen"])
	}

	@Test("latest is the newest sent entry")
	func latest() async {
		let (store, _) = makeStore()
		await store.load()
		#expect(store.latest?.id == store.timeline.last?.id)
	}

	@Test("a comment event that names its parent becomes a reply")
	func replyParent() {
		let event = ObjectEvent(
			id: 9, actorId: "me", action: "commented",
			data: .object(["content": .string("agreed"), "parent_event_id": .number(3)]))
		#expect(ObjectDetailStore.item(from: event)?.parentEventId == 3)
	}
}

@Suite("Activity layout (handoff 8)")
struct ActivityLayoutTests {
	private func item(_ text: String, refs: [String] = []) -> TimelineItem {
		TimelineItem(id: "x", kind: .comment(text), eventId: 1, refs: refs)
	}

	@Test("text over ~110 characters is a comment, shorter is a one-line event")
	func commentThreshold() {
		#expect(!ActivityLayout.isComment(item("Looks good.")))
		#expect(ActivityLayout.isComment(item(String(repeating: "a", count: 111))))
		#expect(ActivityLayout.isComment(item("Short", refs: ["obj"])))
		#expect(!ActivityLayout.isComment(TimelineItem(id: "e", kind: .activity("moved status"))))
	}

	@Test("day labels: Today, Yesterday, weekday within 6 days, otherwise day and month")
	func days() {
		var cal = Calendar(identifier: .gregorian)
		cal.timeZone = TimeZone(identifier: "UTC")!
		cal.locale = Locale(identifier: "en_GB")
		let now = cal.date(from: DateComponents(year: 2026, month: 10, day: 12, hour: 12))!
		func day(_ offset: Int) -> Date { cal.date(byAdding: .day, value: -offset, to: now)! }
		#expect(ActivityLayout.dayLabel(day(0), now: now, calendar: cal) == "Today")
		#expect(ActivityLayout.dayLabel(day(1), now: now, calendar: cal) == "Yesterday")
		#expect(ActivityLayout.dayLabel(day(2), now: now, calendar: cal) == "Sat")
		#expect(ActivityLayout.dayLabel(day(6), now: now, calendar: cal) == "Tue")
		#expect(ActivityLayout.dayLabel(day(7), now: now, calendar: cal) == "5 Oct")
	}

	@Test("times show only for today")
	func times() {
		let cal = Calendar(identifier: .gregorian)
		let now = Date()
		#expect(ActivityLayout.showsTime(now, now: now, calendar: cal))
		#expect(!ActivityLayout.showsTime(now.addingTimeInterval(-86_400 * 2), now: now, calendar: cal))
		#expect(!ActivityLayout.showsTime(nil))
	}

	@Test("reading time rounds up to whole minutes")
	func reading() {
		#expect(ActivityLayout.readMinutes("one two") == 1)
		#expect(ActivityLayout.readMinutes(Array(repeating: "w", count: 450).joined(separator: " ")) == 3)
		#expect(ActivityLayout.readLabel("a b c") == "Read all \u{00B7} 1 min")
	}
}
