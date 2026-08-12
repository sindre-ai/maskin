use keyring::{Entry, Error as KeyringError};

const KEYCHAIN_SERVICE: &str = "io.maskin.mobile";
const KEYCHAIN_ACCOUNT: &str = "api-key";

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
		.invoke_handler(tauri::generate_handler![
			get_api_key,
			set_api_key,
			delete_api_key,
			register_for_remote_notifications,
		])
		.run(tauri::generate_context!())
		.expect("error while running the Maskin Tauri shell")
}
