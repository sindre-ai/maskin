use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Wry};

const KEYCHAIN_SERVICE: &str = "io.maskin.mobile";
const KEYCHAIN_ACCOUNT: &str = "api-key";

const PUSH_NOTIFICATION_TAPPED_EVENT: &str = "push-notification-tapped";

/// Payload the AppDelegate hands us when the user taps a push notification.
/// Both fields are required — the whole point of the deep link is to route to
/// a concrete For You card, so a missing side of the pair means the payload
/// is dropped rather than surfaced.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PendingNotification {
	pub entity_type: String,
	pub entity_id: String,
}

// Cross-platform storage for the last unconsumed tap payload. The cold-start
// path (app launched *by* the notification) needs a slot that survives from
// the AppDelegate hook — which fires before the webview is even attached —
// through to the JS `consume_pending_notification` read after boot.
static PENDING_NOTIFICATION: Mutex<Option<PendingNotification>> = Mutex::new(None);

// AppHandle captured during setup so the FFI entry point can emit a Tauri
// event when a warm-state tap arrives after the app is already up.
static APP_HANDLE: Mutex<Option<AppHandle<Wry>>> = Mutex::new(None);

// APNs registration on iOS: kick UIApplication.registerForRemoteNotifications
// on the main thread. The token itself arrives via the AppDelegate callback
// `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`, which
// Tauri's generated iOS shell owns under `src-tauri/gen/apple/` (git-ignored) —
// that hook is documented as a follow-up in the README.
#[cfg(target_os = "ios")]
#[tauri::command]
fn register_for_remote_notifications() -> Result<(), String> {
	use objc2::runtime::AnyObject;
	use objc2::{class, msg_send, sel};

	unsafe {
		let app: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
		if app.is_null() {
			return Err("UIApplication.sharedApplication is nil".into());
		}
		let selector = sel!(registerForRemoteNotifications);
		let null_arg: *mut AnyObject = std::ptr::null_mut();
		let wait: bool = false;
		let _: () = msg_send![
			app,
			performSelectorOnMainThread: selector,
			withObject: null_arg,
			waitUntilDone: wait
		];
	}
	Ok(())
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn register_for_remote_notifications() -> Result<(), String> {
	Err("register_for_remote_notifications is only implemented on iOS".into())
}

/// C-ABI entry point the iOS AppDelegate calls when a push notification is
/// tapped (cold-start or warm-state). Stashes the payload into a mutex so a
/// later `consume_pending_notification` invocation can read it, and — if the
/// Tauri app is already running — emits `push-notification-tapped` so the JS
/// side can route without waiting for the next foreground poll.
///
/// # Safety
/// `entity_type` and `entity_id` must be non-null, valid, NUL-terminated UTF-8
/// C strings owned by the caller for the duration of this call. The Swift
/// bridge constructs them from Swift `String` via `.utf8CString`, which
/// guarantees both.
#[cfg(target_os = "ios")]
#[no_mangle]
pub unsafe extern "C" fn maskin_push_notification_tapped(
	entity_type: *const std::os::raw::c_char,
	entity_id: *const std::os::raw::c_char,
) {
	use std::ffi::CStr;

	if entity_type.is_null() || entity_id.is_null() {
		return;
	}
	let entity_type = match CStr::from_ptr(entity_type).to_str() {
		Ok(s) => s.to_owned(),
		Err(_) => return,
	};
	let entity_id = match CStr::from_ptr(entity_id).to_str() {
		Ok(s) => s.to_owned(),
		Err(_) => return,
	};
	if entity_type.is_empty() || entity_id.is_empty() {
		return;
	}

	store_pending_notification(PendingNotification { entity_type, entity_id });
}

// Split out from the FFI entry so the same store-and-emit path is unit
// testable on the host — the extern "C" function is iOS-only, but the state
// machine it drives is not.
fn store_pending_notification(payload: PendingNotification) {
	if let Ok(mut slot) = PENDING_NOTIFICATION.lock() {
		*slot = Some(payload.clone());
	}
	if let Ok(handle) = APP_HANDLE.lock() {
		if let Some(app) = handle.as_ref() {
			let _ = app.emit(PUSH_NOTIFICATION_TAPPED_EVENT, payload);
		}
	}
}

/// Read (and clear) the pending push-notification payload stashed by the
/// AppDelegate on tap. The JS side calls this on boot to handle the
/// cold-start case where the app was launched *by* the notification —
/// the AppDelegate's `didFinishLaunchingWithOptions` runs before the
/// webview boots, so the tap payload lands before any JS listener is
/// attached. Returns `None` when nothing is pending.
#[tauri::command]
fn consume_pending_notification() -> Option<PendingNotification> {
	PENDING_NOTIFICATION.lock().ok().and_then(|mut slot| slot.take())
}

/// Read the stored Maskin API key back from the iOS Keychain.
/// Returns None when nothing is stored — a fresh install falls to the login
/// screen with no phantom session.
#[tauri::command]
fn get_api_key() -> Option<String> {
	let entry = Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).ok()?;
	entry.get_password().ok()
}

/// Persist the Maskin API key to the iOS Keychain. The webview never writes
/// the plaintext key to web storage, so this is the only durable home it has.
#[tauri::command]
fn set_api_key(key: String) -> Result<(), String> {
	let entry = Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())?;
	entry.set_password(&key).map_err(|e| e.to_string())
}

/// Remove the Maskin API key from the iOS Keychain on sign-out. Idempotent —
/// deleting a key that is already gone is a success.
#[tauri::command]
fn delete_api_key() -> Result<(), String> {
	let entry = Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())?;
	match entry.delete_credential() {
		Ok(()) => Ok(()),
		Err(KeyringError::NoEntry) => Ok(()),
		Err(e) => Err(e.to_string()),
	}
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	tauri::Builder::default()
		.plugin(tauri_plugin_deep_link::init())
		.plugin(tauri_plugin_notification::init())
		.setup(|app| {
			if let Ok(mut slot) = APP_HANDLE.lock() {
				*slot = Some(app.handle().clone());
			}
			Ok(())
		})
		.invoke_handler(tauri::generate_handler![
			get_api_key,
			set_api_key,
			delete_api_key,
			register_for_remote_notifications,
			consume_pending_notification,
		])
		.run(tauri::generate_context!())
		.expect("error while running the Maskin Tauri shell")
}

#[cfg(test)]
mod tests {
	use super::*;

	fn reset_pending_slot() {
		if let Ok(mut slot) = PENDING_NOTIFICATION.lock() {
			*slot = None;
		}
	}

	#[test]
	fn store_then_consume_returns_the_stashed_payload_once() {
		reset_pending_slot();
		store_pending_notification(PendingNotification {
			entity_type: "bet".into(),
			entity_id: "abc-123".into(),
		});
		let first = consume_pending_notification();
		let second = consume_pending_notification();
		assert!(first.is_some(), "first consume should surface the stored payload");
		let first = first.unwrap();
		assert_eq!(first.entity_type, "bet");
		assert_eq!(first.entity_id, "abc-123");
		assert!(second.is_none(), "second consume should be empty — take-once contract");
	}

	#[test]
	fn store_overwrites_a_previous_unread_payload() {
		reset_pending_slot();
		store_pending_notification(PendingNotification {
			entity_type: "task".into(),
			entity_id: "old".into(),
		});
		store_pending_notification(PendingNotification {
			entity_type: "task".into(),
			entity_id: "new".into(),
		});
		let read = consume_pending_notification().expect("payload present");
		assert_eq!(read.entity_id, "new");
	}
}
