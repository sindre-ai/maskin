#if os(iOS)
	import Foundation
	import MaskinAPI
	import MaskinCore
	import MaskinFeatures
	import Observation

	/// Keeps the paired watch's offline snapshot current: the Needs you cards, the briefing and the
	/// flows the phone already holds, sent through `WatchSessionBridge` whenever they change.
	/// Best effort: with no watch paired the bridge's `publish` is a no-op.
	@MainActor
	final class WatchSnapshotPublisher {
		private let environment: AppEnvironment
		private let bridge: WatchSessionBridge
		private var loops: LoopsStore?
		private var loopsKey: String?
		private var task: Task<Void, Never>?
		private var lastSent: WatchSnapshot?

		init(environment: AppEnvironment, bridge: WatchSessionBridge) {
			self.environment = environment
			self.bridge = bridge
		}

		func start(runtime: AppRuntime) {
			task?.cancel()
			task = Task { [weak self] in
				while !Task.isCancelled {
					guard let self else { return }
					await self.refreshLoopsIfNeeded()
					self.publish(store: runtime.forYou.store)
					await self.nextChange(store: runtime.forYou.store)
					// One snapshot per burst of changes: the feed churns while it syncs.
					try? await Task.sleep(for: .seconds(2))
				}
			}
		}

		func stop() {
			task?.cancel()
			task = nil
			loops?.stop()
			loops = nil
			loopsKey = nil
			lastSent = nil
		}

		private func publish(store: ForYouStore) {
			guard environment.auth.session != nil else { return }
			var briefMarkdown: String?
			if case .loaded(let brief) = store.brief { briefMarkdown = brief.markdown }
			let flows = loops?.phase == .loaded ? loops?.loops ?? [] : []
			let snapshot = WatchSnapshotBuilder.make(
				entries: store.entries, sender: { store.senderName(of: $0) },
				briefMarkdown: briefMarkdown, loops: flows,
				firstName: environment.auth.session?.name.split(separator: " ").first.map(String.init),
				now: Date())
			// `updatedAt` always differs; only a real change is worth waking the watch for.
			var comparable = snapshot
			comparable.updatedAt = lastSent?.updatedAt ?? snapshot.updatedAt
			guard comparable != lastSent else { return }
			lastSent = snapshot
			bridge.publish(snapshot: snapshot)
		}

		private func refreshLoopsIfNeeded() async {
			guard let session = environment.auth.session, let workspaceID = environment.workspaceId
			else {
				loops?.stop()
				loops = nil
				loopsKey = nil
				return
			}
			let key = "\(session.actorId):\(workspaceID)"
			guard key != loopsKey else { return }
			loops?.stop()
			let next = LoopsStore(
				api: APILoopsSource(client: environment.client, workspaceID: workspaceID),
				events: environment.events, cache: environment.snapshotCache)
			loops = next
			loopsKey = key
			await next.start()
		}

		/// Suspends until something the snapshot is built from changes.
		private func nextChange(store: ForYouStore) async {
			await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
				withObservationTracking {
					_ = store.entries
					_ = store.brief
					_ = loops?.loops
					_ = loops?.phase
					_ = environment.auth.session
				} onChange: {
					continuation.resume()
				}
			}
		}
	}
#endif
