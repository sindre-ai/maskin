import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Settings › Sign in a device (v3): a TV shows a short code; you type it here, see which device
/// asked, and approve or refuse. Three steps on one page, as the prototype draws them.
struct DeviceSignInView: View {
	@State private var store: DeviceSignInStore
	@Environment(\.dismiss) private var dismiss

	/// A code that arrived by link (`maskin://connect?code=`) is typed and looked up on open.
	private let initialCode: String?

	init(store: DeviceSignInStore, initialCode: String? = nil) {
		_store = State(initialValue: store)
		self.initialCode = initialCode
	}

	var body: some View {
		WorkspacePage(title: title) {
			switch store.step {
			case .enterCode: enterCode
			case .confirm(let preview): confirm(preview)
			case .approved:
				PageFootnote(text: "You can close this. It takes a few seconds on the device.")
				Button("Done") { finish() }.buttonStyle(.primaryAction)
			case .refused:
				PageFootnote(text: "Nothing was signed in.")
				Button("Done") { finish() }.buttonStyle(.primaryAction)
			}
			if let error = store.error { FormError(error) }
		}
		.overlay { if store.isBusy { ProgressView() } }
		.task {
			guard let initialCode, store.code.isEmpty else { return }
			store.setCode(initialCode)
			if store.canContinue { await store.lookUp() }
		}
	}

	private var title: String {
		switch store.step {
		case .enterCode: "Sign in a device"
		case .confirm(let preview): "Sign in \(preview.client == "tvos" ? "Apple TV" : "this device")?"
		case .approved: "Your device is signing in"
		case .refused: "Sign-in refused"
		}
	}

	@ViewBuilder private var enterCode: some View {
		PageGroupLabel(text: "Code")
		PageTextField(
			title: "XXXX-XXXX", text: Binding(get: { store.code }, set: { store.setCode($0) }),
			mono: true, characters: true, submit: { Task { await store.lookUp() } })
		PageFootnote(text: "Open Maskin on your Apple TV. It shows an 8 character code to type here.")
		Button("Continue") { Task { await store.lookUp() } }
			.buttonStyle(.primaryAction)
			.disabled(!store.canContinue)
	}

	@ViewBuilder private func confirm(_ preview: DeviceSignInPreview) -> some View {
		PageGroupLabel(text: "It will use your account")
		PageCard(rows: [
			PageRowModel(id: "device", title: preview.deviceLabel),
			PageRowModel(
				id: "code", title: "Code on your device",
				accessory: .state(PageState(DeviceCode.format(DeviceCode.normalize(store.code) ?? store.code), .plain))),
		])
		PageFootnote(
			text: "Only approve if the code on your device is \(DeviceCode.format(DeviceCode.normalize(store.code) ?? store.code)).")
		Button("Approve") { Task { await store.approve() } }
			.buttonStyle(.primaryAction).disabled(store.isBusy)
		Button("This isn't me") { Task { await store.refuse() } }
			.buttonStyle(.secondaryAction).disabled(store.isBusy)
	}

	private func finish() {
		store.reset()
		dismiss()
	}
}
