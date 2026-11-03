import Foundation

#if canImport(WatchConnectivity) && (os(iOS) || os(watchOS))
	import WatchConnectivity

	/// Carries the sign-in from the iPhone to the paired watch over `WCSession`.
	/// iPhone: `publish(_:)` on every session change. Watch: `onHandoff` receives each update.
	/// Credentials only ever travel in the application context and are never logged.
	public final class WatchSessionBridge: NSObject, WCSessionDelegate, @unchecked Sendable {
		private let session: WCSession?
		private let lock = NSLock()
		private var handler: (@Sendable (WatchHandoff) -> Void)?
		private var snapshotHandler: (@Sendable (WatchSnapshot) -> Void)?
		private var lastHandoff: WatchHandoff?
		private var lastSnapshot: WatchSnapshot?

		public override init() {
			session = WCSession.isSupported() ? WCSession.default : nil
			super.init()
			session?.delegate = self
			session?.activate()
		}

		/// Watch side. Called on an arbitrary queue; also with the context already waiting at launch.
		public func onHandoff(_ handler: @escaping @Sendable (WatchHandoff) -> Void) {
			lock.withLock { self.handler = handler }
			#if os(watchOS)
				if let session, session.activationState == .activated { deliver(session.receivedApplicationContext) }
			#endif
		}

		/// Watch side: the phone's latest feed/flows/briefing snapshot, so the wrist has data offline.
		public func onSnapshot(_ handler: @escaping @Sendable (WatchSnapshot) -> Void) {
			lock.withLock { self.snapshotHandler = handler }
			#if os(watchOS)
				if let session, session.activationState == .activated {
					deliver(session.receivedApplicationContext)
				}
			#endif
		}

		#if os(iOS)
			/// iPhone side. A no-op until a watch is paired with the app installed.
			public func publish(_ session: StoredSession?) {
				let merged = lock.withLock {
					lastHandoff = WatchHandoff(session: session)
					return mergedContext()
				}
				send(merged)
			}

			/// iPhone side: the snapshot the watch shows offline. The application context holds ONE
			/// dictionary, so it travels together with the sign-in handoff rather than replacing it.
			public func publish(snapshot: WatchSnapshot) {
				let merged = lock.withLock {
					lastSnapshot = snapshot
					return mergedContext()
				}
				send(merged)
			}

			private func mergedContext() -> [String: Any] {
				var context = lastHandoff?.context() ?? [:]
				// A sign-out has no payload of its own, and a snapshot alone must not read as one.
				if let lastHandoff, lastHandoff.session == nil { context[WatchHandoff.signedOutKey] = true }
				if let lastSnapshot { context.merge(lastSnapshot.context()) { _, new in new } }
				return context
			}

			private func send(_ context: [String: Any]) {
				guard let wc = session, wc.activationState == .activated, wc.isPaired,
					wc.isWatchAppInstalled
				else { return }
				try? wc.updateApplicationContext(context)
			}
		#endif

		private func deliver(_ context: [String: Any]) {
			let (handler, snapshotHandler) = lock.withLock { (self.handler, self.snapshotHandler) }
			if let handoff = WatchHandoff.decode(context: context) { handler?(handoff) }
			if let snapshot = WatchSnapshot(context: context) { snapshotHandler?(snapshot) }
		}

		public func session(
			_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?
		) {
			#if os(watchOS)
				if state == .activated { deliver(session.receivedApplicationContext) }
			#endif
		}

		public func session(_ session: WCSession, didReceiveApplicationContext context: [String: Any]) {
			deliver(context)
		}

		#if os(iOS)
			public func sessionDidBecomeInactive(_ session: WCSession) {}
			public func sessionDidDeactivate(_ session: WCSession) { session.activate() }
		#endif
	}
#endif
