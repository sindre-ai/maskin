#if os(iOS)
	import BackgroundTasks
	import MaskinCore
	import MaskinFeatures

	/// Lets iOS wake the app now and then to refetch For You, so the feed, its cache and the
	/// widgets are current when the app is opened. iOS picks the time; this is a best-effort
	/// top-up, not a guarantee (silent push is the prompt path).
	@MainActor
	enum BackgroundRefresh {
		static let identifier = "io.maskin.app.refresh"
		private static let minimumInterval: TimeInterval = 30 * 60

		/// Must run before the app finishes launching (`MaskinApp.init`).
		static func register(environment: AppEnvironment) {
			BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
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
				await runtime.store.refresh()
				task.setTaskCompleted(success: !Task.isCancelled)
			}
			task.expirationHandler = { work.cancel() }
		}
	}
#endif
