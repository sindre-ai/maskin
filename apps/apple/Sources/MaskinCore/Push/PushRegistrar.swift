import Foundation
import Observation

/// Keeps this device's APNs token registered with the backend for the signed-in actor.
///
/// State machine (all transitions funnel through `sync()`):
/// - permission is asked once, explicitly (`requestAuthorization()`), never on launch, and the app
///   only calls it after the in-app pre-prompt (`NotificationPromptCoordinator`) has been accepted;
/// - once authorized, the OS is asked for a token (`registerForRemoteNotifications`), which the
///   app delegate hands back via `didReceive(deviceToken:)`;
/// - the token is uploaded when it, or the signed-in actor, differs from what was last uploaded;
/// - the device owns a secret (random, kept in the Keychain, reused until the APNs token changes)
///   that it sends with every upload. The registration (token, gateway, secret, server id once
///   known) is persisted BEFORE the upload goes out, so a relaunch, a sign-out right after launch
///   or an upload still in flight all know what to remove;
/// - `signOut(perform:)` unregisters that persisted registration with the secret BEFORE
///   credentials are cleared, so a signed-out device stops receiving the previous user's pushes.
///   If that doesn't get through (or an upload was still in flight, so the row may appear later),
///   the registration is kept as pending in the Keychain;
/// - a pending unregister is retried at every launch, every foreground and whenever the network
///   returns, until it succeeds, whether or not anyone is signed in: the secret, not an account,
///   is the credential. It is dropped once the same token is registered again (the upload is an
///   upsert that re-owns the row). A server without the secret route (404 or 405) is not "done":
///   the record stays, and while signed in the owner's authenticated delete is tried instead.
/// - Permission is NOT requested here at sign-in; the app shell asks at a sensible moment.
@MainActor
@Observable
public final class PushRegistrar {
	public enum Registration: Equatable, Sendable {
		case idle
		case registering
		case registered
		case failed(String)
	}

	public private(set) var permission: PushPermission = .notDetermined
	public private(set) var registration: Registration = .idle
	public private(set) var token: String?
	/// Told the server's device id whenever it becomes known (or `nil` on sign-out), so features
	/// that attach to the device (Live Activity tokens) can register against it.
	@ObservationIgnored public var onDeviceChanged: (@MainActor (String?) -> Void)?

	@ObservationIgnored private let system: any PushSystem
	@ObservationIgnored private let devices: any DeviceRegistering
	@ObservationIgnored private let environment: PushEnvironment
	@ObservationIgnored private let platform: DevicePlatform
	@ObservationIgnored private let appVersion: String?
	@ObservationIgnored private var actorId: String?
	/// What the server currently knows, so identical re-syncs are free.
	@ObservationIgnored private var uploaded: (token: String, actorId: String, deviceId: String)?
	/// What this device last told the server, written before each upload.
	@ObservationIgnored private let registrationStore: any DeviceRegistrationStore
	/// The registration an unregister is still owed for.
	@ObservationIgnored private let pendingStore: any DeviceRegistrationStore
	@ObservationIgnored private let makeSecret: @Sendable () -> String
	@ObservationIgnored private var generation = 0
	/// Uploads whose answer hasn't come back: the server may create a row after a sign-out.
	@ObservationIgnored private var uploadsInFlight = 0
	@ObservationIgnored private var isRetrying = false
	@ObservationIgnored private var networkWatch: Task<Void, Never>?
	/// Held so the monitor outlives `init`: its stream only emits while the monitor is alive.
	@ObservationIgnored private let network: (any NetworkMonitoring)?

	/// - Parameter network: when given, a pending unregister is retried each time connectivity returns.
	public init(
		system: any PushSystem, devices: any DeviceRegistering, environment: PushEnvironment,
		platform: DevicePlatform, appVersion: String? = nil,
		registrationStore: any DeviceRegistrationStore = KeychainDeviceRegistrationStore.registration(),
		pendingStore: any DeviceRegistrationStore = KeychainDeviceRegistrationStore.pendingUnregister(),
		network: (any NetworkMonitoring)? = nil,
		makeSecret: @escaping @Sendable () -> String = DeviceRegistration.generateSecret
	) {
		self.registrationStore = registrationStore
		self.pendingStore = pendingStore
		self.makeSecret = makeSecret
		self.system = system
		self.devices = devices
		self.environment = environment
		self.platform = platform
		self.appVersion = appVersion
		self.network = network
		if let network {
			let updates = network.updates()
			networkWatch = Task { [weak self] in
				for await online in updates where online { await self?.retryPendingUnregister() }
			}
		}
	}

	/// Call at launch and whenever the signed-in actor changes (`nil` = signed out). Refreshes
	/// permission, and if already authorized re-requests the token (cheap, and APNs may rotate it).
	public func actorChanged(_ actorId: String?) async {
		self.actorId = actorId
		permission = await system.currentPermission()
		// Before the sign-in guard: the device secret authorises the unregister, so a phone nobody
		// is signed in on still finishes dropping the old account's registration.
		await retryPendingUnregister()
		guard actorId != nil else { return }
		if permission == .authorized { system.registerForRemoteNotifications() }
		await sync()
	}

	/// Every return to the foreground: picks up a permission turned on in iOS Settings, asks for
	/// the token again, and retries an upload that failed (no other trigger would: a failed
	/// upload leaves nothing registered, and `didReceive` only fires when APNs hands over a token).
	public func foregrounded() async {
		await actorChanged(actorId)
	}

	/// Shows the system prompt if the user hasn't decided yet. A denied user is never re-prompted
	/// (the OS wouldn't show it); the UI should point them to Settings instead.
	public func requestAuthorization() async {
		permission = await system.currentPermission()
		if permission == .notDetermined {
			permission = await system.requestPermission() ? .authorized : .denied
			Analytics.shared.track(permission == .authorized ? "push_permission_granted" : "push_permission_denied")
		}
		if permission == .authorized, actorId != nil { system.registerForRemoteNotifications() }
		await sync()
	}

	/// Re-reads the system's answer (the person may have changed it in Settings).
	public func refreshPermission() async -> PushPermission {
		permission = await system.currentPermission()
		return permission
	}

	public func didReceive(deviceToken: Data) async {
		token = deviceToken.pushTokenHex
		await sync()
	}

	public func didFailToRegister(_ error: any Error) {
		registration = .failed(error.localizedDescription)
	}

	/// Unregister this device, then run `signOut`. Unregistering is best-effort and bounded:
	/// a dead network must not trap the user signed in. A failed or timed-out attempt is persisted
	/// as pending rather than forgotten.
	public func signOut(timeout: Duration = .seconds(3), perform signOut: @MainActor () -> Void) async {
		generation += 1
		// The persisted registration, not the in-memory upload: it exists before the token upload
		// finishes and survives a relaunch.
		if let record = registrationStore.load() {
			let devices = devices
			let signedIn = actorId != nil
			let succeeded = await withTaskGroup(of: Bool.self) { group in
				group.addTask { await Self.unregister(record, using: devices, signedIn: signedIn) }
				group.addTask {
					try? await Task.sleep(for: timeout)
					return false
				}
				let first = await group.next() ?? false
				group.cancelAll()
				return first
			}
			// An upload still in flight can create the row after this unregister has run, so it
			// stays pending; `sync()` finishes it when that upload lands.
			pendingStore.save(succeeded && uploadsInFlight == 0 ? nil : record)
		}
		uploaded = nil
		onDeviceChanged?(nil)
		actorId = nil
		registration = .idle
		signOut()
	}

	/// Mirror the unread count onto the app icon.
	public func setBadge(_ count: Int) { system.setBadge(max(0, count)) }

	private func sync() async {
		guard let actorId, let token, permission == .authorized else { return }
		if let uploaded, uploaded.token == token, uploaded.actorId == actorId { return }
		generation += 1
		let mine = generation
		registration = .registering
		// Reuse the secret until the APNs token changes: the app re-registers on every cold launch,
		// and a secret the server never received would make the later unregister delete nothing.
		var record =
			registrationStore.load().flatMap { stored -> DeviceRegistration? in
				stored.token == token && stored.environment == environment ? stored : nil
			}
			?? DeviceRegistration(token: token, environment: environment, secret: makeSecret())
		registrationStore.save(record)
		uploadsInFlight += 1
		defer { uploadsInFlight -= 1 }
		do {
			let deviceId = try await devices.register(
				token: token, environment: environment, platform: platform, appVersion: appVersion,
				unregisterSecret: record.secret)
			record.deviceId = deviceId
			registrationStore.save(record)
			guard mine == generation else {
				// Signed out (or replaced) while the request was out, and the server now has a row.
				if self.actorId == nil { await retryPendingUnregister() }
				return
			}
			uploaded = (token, actorId, deviceId)
			onDeviceChanged?(deviceId)
			// The upsert just re-owned this token's row; deleting it now would undo that.
			if pendingStore.load()?.token == token { pendingStore.save(nil) }
			registration = .registered
		} catch {
			guard mine == generation else { return }
			registration = .failed(error.localizedDescription)
		}
	}

	/// Finish an unregister that didn't get through at sign-out. The device secret is the
	/// credential, so this runs for anyone, signed in or not. It stays pending until the server
	/// answers.
	public func retryPendingUnregister() async {
		guard !isRetrying, let pending = pendingStore.load() else { return }
		// Signed in on this same token and allowed to push: `sync()` re-owns the row and clears
		// the record, and deleting the row now would undo that. (The token can still be unknown
		// right after launch; the retry waits for the next foreground then.)
		if actorId != nil, permission == .authorized, token == nil || token == pending.token { return }
		isRetrying = true
		defer { isRetrying = false }
		if await Self.unregister(pending, using: devices, signedIn: actorId != nil) {
			if pendingStore.load() == pending { pendingStore.save(nil) }
		}
	}

	/// `true` once the server holds no row for this registration. The secret route first (no
	/// credentials); on a server that doesn't have it yet, the owner's authenticated delete while
	/// still signed in. Anything else, including an unreachable server, is `false`.
	private nonisolated static func unregister(
		_ record: DeviceRegistration, using devices: any DeviceRegistering, signedIn: Bool
	) async -> Bool {
		do {
			try await devices.unregister(
				token: record.token, environment: record.environment, secret: record.secret)
			return true
		} catch is DeviceUnregisterRouteMissing {
			guard signedIn, let deviceId = record.deviceId else { return false }
			do {
				try await devices.unregister(deviceId: deviceId)
				return true
			} catch { return false }
		} catch {
			return false
		}
	}
}
