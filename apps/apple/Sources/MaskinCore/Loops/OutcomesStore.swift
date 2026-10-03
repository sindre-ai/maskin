import Foundation
import Observation

/// The Outcomes feed: what every loop in the workspace has produced, newest first, grouped by
/// loop. Built from the loops' own graphs plus one batched file-metadata request, and kept current
/// by live events.
@MainActor
@Observable
public final class OutcomesStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading, loaded
		case failed(String)
	}

	public private(set) var groups: [OutcomeGroup] = []
	public private(set) var phase: Phase = .idle

	@ObservationIgnored private let loopsAPI: any LoopsAPI
	@ObservationIgnored private let files: any FilesRemote
	@ObservationIgnored private let events: EventHub?
	@ObservationIgnored private let debouncer: RefreshDebouncer
	@ObservationIgnored private var listener: Task<Void, Never>?
	@ObservationIgnored private var refreshing = false
	@ObservationIgnored private var refreshQueued = false

	public init(loops: any LoopsAPI, files: any FilesRemote, events: EventHub?) {
		self.loopsAPI = loops
		self.files = files
		self.events = events
		self.debouncer = RefreshDebouncer()
	}

	/// Test seam: a custom wait between a live event and the refetch it causes.
	init(
		loops: any LoopsAPI, files: any FilesRemote, events: EventHub?, debounce: Duration,
		sleep: @escaping RefreshDebouncer.Sleep
	) {
		self.loopsAPI = loops
		self.files = files
		self.events = events
		self.debouncer = RefreshDebouncer(delay: debounce, sleep: sleep)
	}

	public var outcomeCount: Int { groups.reduce(0) { $0 + $1.outcomes.count } }

	public func start() async {
		if listener == nil, let events {
			let stream = events.subscribe()
			listener = Task { [weak self] in
				for await signal in stream {
					guard let self else { return }
					switch signal {
					case .reconnected:
						await self.refresh()
					case .event(let event) where Self.affectsOutcomes(event.entityType):
						self.scheduleRefresh()
					default:
						break
					}
				}
			}
		}
		await refresh()
	}

	/// Outputs are files attached through relationships, on objects that belong to loops.
	static func affectsOutcomes(_ type: EntityType) -> Bool {
		type == .object || type == .file || type == .relationship
	}

	public func stop() {
		listener?.cancel()
		listener = nil
		debouncer.cancel()
	}

	private func scheduleRefresh() {
		debouncer.schedule { [weak self] in await self?.refresh() }
	}

	public func refresh() async {
		if refreshing {
			refreshQueued = true
			return
		}
		refreshing = true
		defer { refreshing = false }
		repeat {
			refreshQueued = false
			if groups.isEmpty { phase = .loading }
			do {
				groups = try await load()
				phase = .loaded
			} catch {
				if groups.isEmpty { phase = .failed(Self.message(error)) }
			}
		} while refreshQueued
	}

	private func load() async throws -> [OutcomeGroup] {
		let loops = try await loopsAPI.loops()
		let api = loopsAPI
		// One graph read per loop, in parallel; a loop whose graph can't be read just has no outputs.
		let entries = await withTaskGroup(of: (Int, [LoopOutput]).self) { group in
			for (index, loop) in loops.enumerated() {
				group.addTask { (index, (try? await api.overview(loopID: loop.id).outputs) ?? []) }
			}
			var outputs: [Int: [LoopOutput]] = [:]
			for await (index, found) in group { outputs[index] = found }
			return loops.enumerated().map { (loop: $1, outputs: outputs[$0] ?? []) }
		}
		let ids = entries.flatMap { $0.outputs.map(\.id) }
		let summaries = ids.isEmpty ? [] : try await files.summaries(ids: ids)
		return OutcomeBuilder.groups(
			entries: entries, files: Dictionary(summaries.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }))
	}

	private static func message(_ error: Error) -> String {
		(error as? FileError)?.message ?? AutomationError.message(error)
	}
}
