import Foundation

@testable import MaskinCore

func loopRow(
	_ id: String, name: String? = "Loop", status: LoopPill = .learning, waiting: Int = 0,
	agents: [String] = ["agent-1"], inProgress: Int = 2, closed: Int = 5
) -> LoopSummary {
	LoopSummary(
		id: id, name: name, status: status,
		pill: (status.isLive && waiting > 0) ? .waitingOnYou : status, inProgressCount: inProgress,
		closedCount: closed, agentIDs: agents, triggerIDs: ["t1"], waitingCount: waiting)
}

actor FakeLoopsAPI: LoopsAPI {
	var rows: [LoopSummary]
	var stepRows: [LoopStep] = []
	var feed: [LoopActivityEntry] = []
	var overviewRow: LoopOverview = .empty
	var installRows: [LoopInstall] = []
	var failStatus = false
	var failLoops = false
	var statusDelay: Duration?
	private(set) var statusCalls: [(String, LoopPill)] = []
	private(set) var loopCalls = 0
	private(set) var statusKeys: [String] = []
	var failEdit = false
	private(set) var createCalls: [(String, String, String)] = []
	private(set) var updateCalls: [(String, String?, String?)] = []
	private(set) var deleted: [String] = []
	func setFailEdit(_ value: Bool) { failEdit = value }

	init(_ rows: [LoopSummary]) { self.rows = rows }

	func set(_ rows: [LoopSummary]) { self.rows = rows }
	func setSteps(_ steps: [LoopStep]) { stepRows = steps }
	func setOverview(_ value: LoopOverview) { overviewRow = value }
	func setFeed(_ entries: [LoopActivityEntry]) { feed = entries }
	func setInstalls(_ rows: [LoopInstall]) { installRows = rows }
	func setFailStatus(_ value: Bool) { failStatus = value }
	func setFailLoops(_ value: Bool) { failLoops = value }
	func setStatusDelay(_ value: Duration?) { statusDelay = value }

	func loops() async throws -> [LoopSummary] {
		loopCalls += 1
		if failLoops { throw AutomationError("offline") }
		return rows
	}
	func steps(loopID: String) async throws -> [LoopStep] { stepRows }
	func activity(loopID: String) async throws -> [LoopActivityEntry] { feed }
	func overview(loopID: String) async throws -> LoopOverview { overviewRow }
	func actors() async throws -> [AutomationActor] { testActors }
	func installs() async throws -> [LoopInstall] { installRows }

	func setStatus(loopID: String, status: LoopPill, idempotencyKey: String) async throws {
		statusCalls.append((loopID, status))
		statusKeys.append(idempotencyKey)
		if let statusDelay { try await Task.sleep(for: statusDelay) }
		if failStatus { throw AutomationError("server said no") }
		if let i = rows.firstIndex(where: { $0.id == loopID }) { rows[i] = rows[i].with(status: status) }
	}
}

extension FakeLoopsAPI {
	func createLoop(name: String, content: String, idempotencyKey: String) async throws -> String {
		createCalls.append((name, content, idempotencyKey))
		if failEdit { throw AutomationError("nope") }
		let id = "new-\(createCalls.count)"
		rows.insert(LoopSummary(id: id, name: name, content: content, status: .learning), at: 0)
		return id
	}
	func updateLoop(loopID: String, name: String?, content: String?, idempotencyKey: String) async throws {
		updateCalls.append((loopID, name, content))
		if failEdit { throw AutomationError("nope") }
	}
	func deleteLoop(loopID: String) async throws {
		if failEdit { throw AutomationError("nope") }
		deleted.append(loopID)
	}
}

func objectFrame(_ id: Int, entity: String = "object") -> String {
	let json =
		#"{"workspace_id":"w1","actor_id":"a","action":"updated","entity_type":"\#(entity)","entity_id":"x","event_id":"\#(id)"}"#
	return "id: \(id)\nevent: updated\ndata: \(json)\n\n"
}
