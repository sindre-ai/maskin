import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One extension (v3): on or off, where its webhook listens and how deliveries are going. Editing
/// the webhook, the secret and the field mapping stays on the web.
struct ExtensionDetailView: View {
	let store: ExtensionsStore
	let extensionID: String

	var body: some View {
		List {
			if let ext = store.extensionRow(id: extensionID) {
				Section {
					if store.canManage, ext.status != .draft {
						Toggle(
							"On",
							isOn: Binding(
								get: { ext.status == .active },
								set: { on in Task { await store.setEnabled(on, for: ext) } })
						)
						.disabled(store.busyIDs.contains(ext.id))
						.frame(minHeight: MaskinSpace.touchMin)
					} else {
						LabeledContent("Status", value: ext.statusLabel)
					}
				} header: {
					Text("Status")
				} footer: {
					if !store.canManage { Text("Only the workspace owner can switch an extension.") }
				}
				if ext.hasWebhook {
					Section("Webhook") {
						if let url = ext.webhookURL {
							Button {
								PlainPasteboard.copy(url)
							} label: {
								VStack(alignment: .leading, spacing: MaskinSpace.s1) {
									Text("Endpoint").foregroundStyle(MaskinColor.ink)
									Text(url).font(.footnote).foregroundStyle(MaskinColor.ink4)
										.lineLimit(2).truncationMode(.middle)
								}
								.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
							}
							.accessibilityHint("Copies the endpoint")
						}
						LabeledContent("Secret", value: ext.hasSigningSecret ? "Set" : "Not set")
						LabeledContent("Deliveries", value: deliveries(ext))
					}
				}
				if let error = ext.lastError {
					Section {
						Text(error).foregroundStyle(MaskinColor.warning)
					} header: {
						Text("Last error")
					}
				}
				if let error = store.actionError { Section { FormError(error) } }
			}
		}
		.settingsListStyle()
		.navigationTitle(store.extensionRow(id: extensionID)?.name ?? "Extension")
		#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
		#endif
	}

	/// "12 received, last 2 h ago"; "None yet" before the first one.
	private func deliveries(_ ext: WorkspaceExtension) -> String {
		guard ext.committedDeliveries > 0 else { return "None yet" }
		guard let last = ext.lastDeliveryAt else { return "\(ext.committedDeliveries) received" }
		let ago = last.formatted(.relative(presentation: .named))
		return "\(ext.committedDeliveries) received, last \(ago)"
	}
}
