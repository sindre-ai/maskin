import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Integrations › Add tool server (v3): a name, a URL and an optional key. A new server reaches
/// no agent until a person grants it.
struct AddToolServerView: View {
	@State private var store: AddToolServerStore
	@Environment(\.dismiss) private var dismiss
	let onAdded: () -> Void

	init(store: AddToolServerStore, onAdded: @escaping () -> Void) {
		_store = State(initialValue: store)
		self.onAdded = onAdded
	}

	var body: some View {
		WorkspacePage(title: "Add tool server") {
			PageGroupLabel(text: "Name")
			PageTextField(title: "linear-mcp", text: $store.draft.name)
			PageGroupLabel(text: "URL")
			PageTextField(title: "https://mcp.example.com/mcp", text: $store.draft.url, isURL: true)
			PageGroupLabel(text: "Key (optional)")
			PageTextField(title: "Bearer key", text: $store.draft.key, mono: true, isURL: true, secure: true)
			PageFootnote(
				text: "The key is stored encrypted and never shown again. No agent can use the server until you give it access.")
			if let error = store.error { FormError(error) }
			Button("Add server") {
				Task {
					await store.save()
					if store.didAdd {
						onAdded()
						dismiss()
					}
				}
			}
			.buttonStyle(.primaryAction)
			.disabled(!store.canSave)
		}
		.overlay { if store.isSaving { ProgressView() } }
	}
}

/// Integrations › Import from Claude (v3): the Claude subscriptions agents run on. Importing a
/// subscription needs the credentials file from a computer, so that step opens the web.
struct ClaudeAccountView: View {
	@State private var store: ClaudeAccountStore
	@Environment(\.openURL) private var openURL
	let importURL: URL?

	init(store: ClaudeAccountStore, importURL: URL?) {
		_store = State(initialValue: store)
		self.importURL = importURL
	}

	var body: some View {
		WorkspacePage(title: "Import from Claude") {
			switch store.phase {
			case .loaded(let status):
				if status.slots.isEmpty {
					PageStatus(text: "No Claude subscription is connected.")
				} else {
					PageGroupLabel(text: "Account")
					PageCard(rows: status.slots.map(row))
				}
				PageFootnote(
					text: "Agents run on your Claude plan, so their work does not draw on credits. Importing needs the Claude sign-in from a computer.")
				if let importURL {
					Button("Import on web") { openURL(importURL) }.buttonStyle(.primaryAction)
				}
			case .failed(let message): PageStatus(text: message)
			default: PageStatus(text: "Loading your Claude account")
			}
		}
		.task { await store.load() }
		.refreshable { await store.load() }
	}

	private func row(_ slot: ClaudeSlot) -> PageRowModel {
		PageRowModel(
			id: slot.id, title: slot.title,
			subtitle: slot.nickname?.isEmpty == false ? slot.planLabel : nil,
			accessory: .state(slot.isFailing ? PageState("Needs attention", .notice) : PageState("Connected", .active)))
	}
}
