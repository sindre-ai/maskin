import Foundation
import Observation

/// Keeps this device's APNs token registered with the backend for the signed-in actor.
///
/// State machine (all transitions funnel through `sync()`):
/// - permission is asked once, explicitly (`requestAuthorization()`), never on launch;
/// - once authorized, the OS is asked for a token (`registerForRemoteNotifications`), which the
///   app delegate hands back via `didReceive(deviceToken:)`;
/// - the token is uploaded when it, or the signed-in actor, differs from what was last uploaded;
/// - `signOut(perform:)` unregisters the device (by its server id) BEFORE credentials are
///   cleared, so a signed-out device stops receiving the previous user's pushes. If that doesn't
///   get through, the unregister is persisted as pending. It is dropped once the same token is
///   registered again (the upload is an upsert that re-owns the row), and retried when the same
///   actor signs back in after the token rotated. Nobody else can delete the row, so for a device
///   nobody signs in on again the backend's APNs-feedback pruning is the backstop.
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

	@ObservationIgnored private let system: any PushSystem
	@ObservationIgnored private let devices: any DeviceRegistering
	@ObservationIgnored private let environment: PushEnvironment
	@ObservationIgnored private let platform: DevicePlatform
	@ObservationIgnored private let appVersion: String?
	@ObservationIgnored private var actorId: String?
	/// What the server currently knows, so identical re-syncs are free.
	@ObservationIgnored private var uploaded: (token: String, actorId: String, deviceId: String)?
	@ObservationIgnored private let pendingStore: any PendingUnregisterStore
	@ObservationIgnored private var generation = 0

	public init(
		system: any PushSystem, devices: any DeviceRegistering, environment: PushEnvironment,
		platform: DevicePlatform, appVersion: String? = nil,
		pendingStore: any PendingUnregisterStore = UserDefaultsPendingUnregisterStore()
	) {
		self.pendingStore = pendingStore
		self.system = system
		self.devices = devices
		self.environment = environment
		self.platform = platform
		self.appVersion = appVersion
	}

	/// Call at launch and whenever the signed-in actor changes (`nil` = signed out). Refreshes
	/// permission, and if already authorized re-requests the token (cheap, and APNs may rotate it).
	public func actorChanged(_ actorId: String?) async {
		self.actorId = actorId
		permission = await system.currentPermission()
		guard actorId != nil else { return }
		if permission == .authorized { system.registerForRemoteNotifications() }
		await retryPendingUnregister()
		await sync()
	}

	/// Shows the system prompt if the user hasn't decided yet. A denied user is never re-prompted
	/// (the OS wouldn't show it); the UI should point them to Settings instead.
	public func requestAuthorization() async {
		permission = await system.currentPermission()
		if permission == .notDetermined {
			permission = await system.requestPermission() ? .authorized : .denied
		}
		if permission == .authorized, actorId != nil { system.registerForRemoteNotifications() }
		await sync()
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
		if let uploaded {
			let devices = devices
			let deviceId = uploaded.deviceId
			let succeeded = await withTaskGroup(of: Bool.self) { group in
				group.addTask {
					do {
						try await devices.unregister(deviceId: deviceId)
						return true
					} catch { return false }
				}
				group.addTask {
					try? await Task.sleep(for: timeout)
					return false
				}
				let first = await group.next() ?? false
				group.cancelAll()
				return first
			}
			if !succeeded {
				pendingStore.save(
					PendingUnregister(deviceId: deviceId, token: uploaded.token, actorId: uploaded.actorId))
			}
		}
		uploaded = nil
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
		do {
			let deviceId = try await devices.register(
				token: token, environment: environment, platform: platform, appVersion: appVersion)
			guard mine == generation else { return }
			uploaded = (token, actorId, deviceId)
			// The upsert just re-owned this token's row; deleting it now would undo that.
			if pendingStore.load()?.token == token { pendingStore.save(nil) }
			registration = .registered
		} catch {
			guard mine == generation else { return }
			registration = .failed(error.localizedDescription)
		}
	}

	/// Finish an unregister that didn't get through at sign-out. Only the actor that owned the
	/// row can delete it, so any other actor just drops it (their own registration re-owns the
	/// token anyway). The same token is left alone: registering it again re-owns the row.
	private func retryPendingUnregister() async {
		guard let pending = pendingStore.load(), let actorId else { return }
		guard pending.actorId == actorId else {
			pendingStore.save(nil)
			return
		}
		guard pending.token != token else { return }  // same token: sync() re-owns it and clears
		do {
			try await devices.unregister(deviceId: pending.deviceId)
			pendingStore.save(nil)
		} catch {
			// Stays pending; the next sign-in tries again.
		}
	}
}
