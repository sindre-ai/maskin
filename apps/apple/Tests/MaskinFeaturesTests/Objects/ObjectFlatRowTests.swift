import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("ObjectFlatRow subtitle")
struct ObjectFlatRowTests {
	private func row(showsType: Bool = true, owner: String? = "Architect", showsDriver: Bool = true) -> ObjectFlatRow {
		ObjectFlatRow(
			object: WorkObject(id: "o", type: "task", title: "Read the webhook signing secret", status: "proposed"),
			typeName: "Task", showsType: showsType, ownerName: owner, showsDriver: showsDriver)
	}

	@Test func readsTypeThenOwner() {
		#expect(row().subtitle == "Task · Architect")
	}

	@Test func dropsTheTypeWhenTheListHoldsOneType() {
		#expect(row(showsType: false).subtitle == "Architect")
	}

	@Test func dropsAnUnresolvedOwner() {
		#expect(row(owner: nil).subtitle == "Task")
		#expect(row(showsDriver: false).subtitle == "Task")
	}
}
