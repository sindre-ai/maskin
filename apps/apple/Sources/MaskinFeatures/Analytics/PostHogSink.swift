import Foundation
import MaskinCore

#if os(iOS)
	import PostHog
#endif

/// The PostHog iOS SDK behind `AnalyticsSink`. The only file that imports it.
///
/// The SDK is left as quiet as it can be: we send our own events with the web app's names, so its
/// lifecycle events, automatic screen views, tap capture, push capture, error capture and feature
/// flag calls are all off. It is set up only after the person has agreed (`Analytics` calls
/// `start()` then), so nothing is stored or sent before that. iPhone only: other platforms get no
/// sink, because every event says `surface: iphone`.
@MainActor
public final class PostHogSink: AnalyticsSink {
	private let token: String
	private let host: String
	#if os(iOS)
		private var isSetUp = false
	#endif

	init(token: String, host: String) {
		self.token = token
		self.host = host
	}

	/// The sink for this build, or nil when there is no project token (local builds, CI) or the
	/// platform is not iPhone. Keys: `MaskinPostHogKey`, `MaskinPostHogHost` in Info.plist, filled
	/// from the `MASKIN_POSTHOG_KEY` / `MASKIN_POSTHOG_HOST` build settings.
	public static func forThisBuild(bundle: Bundle = .main) -> PostHogSink? {
		#if os(iOS)
			let info = bundle.infoDictionary
			let token = (info?["MaskinPostHogKey"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
			// An unfilled `$(MASKIN_POSTHOG_KEY)` placeholder is not a token.
			guard !token.isEmpty, !token.hasPrefix("$(") else { return nil }
			let host = (info?["MaskinPostHogHost"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
			return PostHogSink(token: token, host: host.isEmpty || host.hasPrefix("$(") ? "https://eu.i.posthog.com" : host)
		#else
			return nil
		#endif
	}

	public func start() {
		#if os(iOS)
			if !isSetUp {
				let config = PostHogConfig(projectToken: token, host: host)
				config.captureApplicationLifecycleEvents = false
				config.captureScreenViews = false
				config.enableSwizzling = false
				config.capturePushNotificationSubscriptions = false
				config.capturePushNotificationOpened = false
				config.errorTrackingConfig.autoCapture = false
				config.preloadFeatureFlags = false
				config.sendFeatureFlagEvent = false
				config.setDefaultPersonProperties = false
				config.personProfiles = .identifiedOnly
				PostHogSDK.shared.setup(config)
				isSetUp = true
			}
			// The SDK keeps its own opt-out across launches; the person's answer here is the truth.
			PostHogSDK.shared.optIn()
		#endif
	}

	public func identify(_ distinctId: String) {
		#if os(iOS)
			guard isSetUp else { return }
			PostHogSDK.shared.identify(distinctId)
		#endif
	}

	public func group(type: String, key: String) {
		#if os(iOS)
			guard isSetUp else { return }
			PostHogSDK.shared.group(type: type, key: key, groupProperties: ["workspace_id": key])
		#endif
	}

	public func capture(_ event: String, properties: AnalyticsProperties) {
		#if os(iOS)
			guard isSetUp else { return }
			PostHogSDK.shared.capture(event, properties: properties.mapValues(\.anyValue))
		#endif
	}

	public func reset() {
		#if os(iOS)
			guard isSetUp else { return }
			PostHogSDK.shared.reset()
		#endif
	}

	public func stop() {
		#if os(iOS)
			guard isSetUp else { return }
			// Reset first: it also clears the SDK's stored opt-out, which `optOut()` then sets again.
			PostHogSDK.shared.reset()
			PostHogSDK.shared.optOut()
		#endif
	}
}
