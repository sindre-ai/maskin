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

		#if os(iOS)
			/// iPhone side. A no-op until a watch is paired with the app installed.
			public func publish(_ session: StoredSession?) {
				guard let wc = self.session, wc.activationState == .activated, wc.isPaired,
					wc.isWatchAppInstalled
				else { return }
				try? wc.updateApplicationContext(WatchHandoff(session: session).context())
			}
		#endif

		private func deliver(_ context: [String: Any]) {
			guard let handoff = WatchHandoff(context: context) else { return }
			let handler = lock.withLock { self.handler }
			handler?(handoff)
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
