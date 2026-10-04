import Foundation
import Observation

/// The loops and triggers that run a given set of agents: what a chat thread offers as
/// "Routines" when one of its participants is an agent with automation behind it.
///
/// Loops carry `agentIDs` (their pipeline's agents); a trigger carries one `targetActorID`.
/// A trigger that already belongs to a matched loop is folded into that loop, so the person
/// sees "Weekly review" once, not the loop and each of its steps.
public struct AgentRoutines: Equatable, Sendable {
	public var loops: [LoopSummary]
	/// Triggers aimed at these agents that no matched loop already covers.
	public var triggers: [Trigger]

	public init(loops: [LoopSummary] = [], triggers: [Trigger] = []) {
		self.loops = loops
		self.triggers = triggers
	}

	public var isEmpty: Bool { loops.isEmpty && triggers.isEmpty }

	public static func lookup(
		agentIDs: Set<String>, loops: [LoopSummary], triggers: [Trigger]
	) -> AgentRoutines {
		guard !agentIDs.isEmpty else { return AgentRoutines() }
		let matchedLoops = loops.filter { !agentIDs.isDisjoint(with: $0.agentIDs) }
		let covered = Set(matchedLoops.flatMap(\.triggerIDs))
		let matchedTriggers = triggers.filter {
			agentIDs.contains($0.targetActorID) && !covered.contains($0.id)
		}
		return AgentRoutines(loops: matchedLoops, triggers: matchedTriggers)
	}
}

/// Where "open this routine" should land in the Loops tab.
public enum RoutineTarget: Equatable, Hashable, Sendable {
	case loop(String)
	case trigger(String)
}

/// Loads the routines of a thread's agents. Best effort: a failure just means no menu entry.
@MainActor
@Observable
public final class AgentRoutinesLoader {
	public private(set) var routines = AgentRoutines()

	@ObservationIgnored private let loopsAPI: any LoopsAPI
	@ObservationIgnored private let triggersAPI: any TriggersAPI

	public init(loopsAPI: any LoopsAPI, triggersAPI: any TriggersAPI) {
		self.loopsAPI = loopsAPI
		self.triggersAPI = triggersAPI
	}

	public func load(agentIDs: Set<String>) async {
		guard !agentIDs.isEmpty else {
			routines = AgentRoutines()
			return
		}
		async let loops = try? loopsAPI.loops()
		async let triggers = try? triggersAPI.list()
		let (l, t) = await (loops, triggers)
		// Both failing keeps whatever was there; one failing still shows the other.
		if l == nil && t == nil { return }
		routines = AgentRoutines.lookup(agentIDs: agentIDs, loops: l ?? [], triggers: t ?? [])
	}
}
