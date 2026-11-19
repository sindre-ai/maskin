import Foundation
import MaskinAPI

#if os(iOS)
	import Sentry
#endif

/// The Sentry SDK behind `ErrorReportSink`. The only file that imports it.
///
/// Reports crashes, and the failed calls `ErrorReporter` lets through, to the native app's own
/// Sentry project (maskin-ios). Everything that could carry a person's words is switched off or
/// stripped before an event leaves the phone: no user, no screenshots, no view hierarchy, no
/// breadcrumbs, no request data, no extra data, no exception text.
///
/// Also reports app hangs (the main thread frozen for 2 seconds) and watchdog kills (the system
/// ending the app for freezing or memory), the two ways a phone seems to restart with no crash log. What stays is the app version
/// and build, the OS version, the device model, the workspace id and the stack trace.
///
/// Off in debug builds and in test runs, and in any build with no address (`MaskinSentryDSN` in
/// Info.plist, filled from `MASKIN_SENTRY_DSN`; only the TestFlight workflow sets it). iPhone only.
public final class SentrySink: ErrorReportSink {
	private let dsn: String

	init(dsn: String) { self.dsn = dsn }

	/// The sink for this build, or nil when it must stay silent.
	public static func forThisBuild(bundle: Bundle = .main) -> SentrySink? {
		#if os(iOS) && !DEBUG
			// A Release build can still run under a test host.
			guard NSClassFromString("XCTestCase") == nil,
				ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil
			else { return nil }
			let dsn =
				(bundle.infoDictionary?["MaskinSentryDSN"] as? String)?
				.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
			// An unfilled `$(MASKIN_SENTRY_DSN)` placeholder is not an address.
			guard !dsn.isEmpty, !dsn.hasPrefix("$(") else { return nil }
			return SentrySink(dsn: dsn)
		#else
			return nil
		#endif
	}

	/// Starts crash reporting. Call once, as early as possible at launch.
	public func start(bundle: Bundle = .main) {
		#if os(iOS)
			let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
			let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
			let dsn = self.dsn
			SentrySDK.start { options in
				options.dsn = dsn
				options.sendDefaultPii = false
				options.attachScreenshot = false
				options.attachViewHierarchy = false
				options.tracesSampleRate = 0
				options.enableAutoPerformanceTracing = false
				options.enableAutoSessionTracking = false
				// The phone "restarting" is often the system killing the app for freezing or for
				// memory, and Apple sends no crash log for that. These two report it, through the
				// same scrub as crashes. Hang tracking switches itself off under a debugger.
				options.enableAppHangTracking = true
				options.enableWatchdogTerminationTracking = true
				// A watchdog report reads the last run's breadcrumbs back from disk in a form the scrub
				// below cannot reach. Nothing adds any, and this keeps it that way.
				options.maxBreadcrumbs = 0
				options.enableAutoBreadcrumbTracking = false
				options.enableNetworkBreadcrumbs = false
				options.enableCaptureFailedRequests = false
				options.enableUserInteractionTracing = false
				options.beforeSend = { event in SentrySink.scrub(event) }
			}
			SentrySDK.configureScope { scope in
				if let version { scope.setTag(value: version, key: "app_version") }
				if let build { scope.setTag(value: build, key: "build") }
			}
		#endif
	}

	public func send(_ report: ErrorReport) {
		#if os(iOS)
			SentrySDK.capture(message: "Request failed (\(report.kind.rawValue))") { scope in
				for (key, value) in report.tags { scope.setTag(value: value, key: key) }
				// One issue per kind and operation, whatever the title says.
				scope.setFingerprint([report.kind.rawValue, report.operationID])
			}
		#endif
	}

	public func workspaceChanged(_ workspaceId: String?) {
		#if os(iOS)
			SentrySDK.configureScope { scope in
				if let workspaceId {
					scope.setTag(value: workspaceId, key: "workspace_id")
				} else {
					scope.removeTag(key: "workspace_id")
				}
			}
		#endif
	}

	#if os(iOS)
		/// The last step before an event leaves the phone, for crashes and reports alike.
		static func scrub(_ event: Event) -> Event? {
			event.user = nil
			event.request = nil
			event.breadcrumbs = nil
			event.extra = nil
			event.serverName = nil
			event.tags = ErrorReportTags.scrub(event.tags ?? [:])
			// A crash's exception text can hold whatever the code was working on. The type and the
			// stack trace say what happened.
			for exception in event.exceptions ?? [] {
				exception.value = ErrorReportScrub.exceptionText(type: exception.type)
			}
			// Keep the hardware and OS description, drop everything else the SDK collected.
			event.context = ErrorReportScrub.contexts(event.context ?? [:])
			return event
		}
	#endif
}
