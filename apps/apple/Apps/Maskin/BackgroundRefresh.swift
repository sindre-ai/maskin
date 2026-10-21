#if os(iOS)
	import BackgroundTasks
	import MaskinCore
	import MaskinFeatures

	/// Lets iOS wake the app now and then to refetch For You (so the feed, the briefings, their cache and the
	/// widgets are current when the app is opened) and the running sessions behind the "Agents
	/// working" Live Activity. iOS picks the time; this is a best-effort
	/// top-up, not a guarantee (silent push is the prompt path).
	@MainActor
	enum BackgroundRefresh {
		static let identifier = "io.maskin.app.refresh"
		private static let minimumInterval: TimeInterval = 30 * 60

		/// Must run before the app finishes launching (`MaskinApp.init`).
		/// The handler runs on the main queue: `assumeIsolated` below traps if iOS calls it on the
		/// scheduler's own background queue (`using: nil`), which killed build 2610081414 on every wake.
		static func register(environment: AppEnvironment) {
			BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
				guard let task = task as? BGAppRefreshTask else { return }
				MainActor.assumeIsolated { run(task, environment: environment) }
			}
		}

		/// Ask for the next wake-up. Call when the app goes to the background.
		static func schedule() {
			let request = BGAppRefreshTaskRequest(identifier: identifier)
			request.earliestBeginDate = Date(timeIntervalSinceNow: minimumInterval)
			try? BGTaskScheduler.shared.submit(request)
		}

		private static func run(_ task: BGAppRefreshTask, environment: AppEnvironment) {
			schedule()  // chain the next one first, so a failure here doesn't end the series
			guard environment.auth.session != nil else {
				task.setTaskCompleted(success: true)
				return
			}
			let runtime = ForYouRuntime.make(environment: environment, start: false)
			runtime.store.widgetReloader = makeWidgetReloader()
			let work = Task { @MainActor in
				async let feed: Void = runtime.store.refresh()
				async let stories: Void = BackgroundStories.refresh(environment: environment)
				_ = await (feed, stories)
				await AgentsActivityRuntime.shared?.refresh()
				task.setTaskCompleted(success: !Task.isCancelled)
			}
			task.expirationHandler = { work.cancel() }
		}
	}
#endif
