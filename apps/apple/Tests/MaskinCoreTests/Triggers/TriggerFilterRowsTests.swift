import Testing

@testable import MaskinCore

@Suite("TriggerDescriber.filters")
struct TriggerFilterRowsTests {
	@Test("a status change reads as from and to")
	func statusChange() {
		let config: JSONValue = .object([
			"entity_type": .string("task"), "action": .string("status_changed"),
			"from_status": .string("todo"), "to_status": .string("in_progress"),
		])
		let rows = TriggerDescriber.filters(config: config)
		#expect(rows == [TriggerFilterRow(label: "Status", value: "from todo to in progress")])
	}

	@Test("people resolve to names and unknown ids never show")
	func peopleNeverShowIDs() {
		let config: JSONValue = .object([
			"filter": .object(["actorId": .string("actor-9"), "on_target_type": .string("bet")]),
			"conditions": .array([
				.object(["field": .string("mentions"), "operator": .string("contains"), "value": .string("actor-1")])
			]),
		])
		let rows = TriggerDescriber.filters(config: config) { $0 == "actor-1" ? "Strategist" : nil }
		#expect(rows.contains(TriggerFilterRow(label: "From", value: "Someone specific")))
		#expect(rows.contains(TriggerFilterRow(label: "Mentions", value: "Strategist")))
		#expect(rows.contains(TriggerFilterRow(label: "On items of type", value: "Bet")))
		#expect(!rows.contains { $0.value.contains("actor-") })
	}

	@Test("a provider list shows only its size")
	func providerListCount() {
		let config: JSONValue = .object([
			"filter": .object(["channels": .array([.string("C01"), .string("C02")])])
		])
		#expect(TriggerDescriber.filters(config: config) == [TriggerFilterRow(label: "Channels", value: "2 selected")])
	}
}

@Suite("TriggerDraft.readBack")
struct TriggerReadBackTests {
	@Test("reads an event rule once an agent is chosen")
	func readsEvent() {
		var draft = TriggerDraft()
		draft.whenKind = .event
		#expect(draft.readBack(agentName: "Strategist") == nil)
		draft.event = TriggerEventRule(entityType: "task", action: "created")
		#expect(draft.readBack(agentName: nil) == nil)
		#expect(draft.readBack(agentName: "Strategist") == "When task created, run Strategist.")
	}
}
