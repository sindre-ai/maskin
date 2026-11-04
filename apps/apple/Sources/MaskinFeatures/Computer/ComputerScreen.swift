#if os(iOS)
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// An agent's live computer, in the app. It opens view-only so watching can never nudge the agent;
/// Take over switches to taps and keys. The same states as the web viewer: Starting, Connecting,
/// Live, Idle (Wake up) and Error (Reconnect). Every connect asks the server for a new one-time
/// ticket, and going to the background drops the stream and shows Idle instead of reconnecting.
struct ComputerScreen: View {
	let agentName: String
	/// Hands control back to the agent (the card's Done).
	let onDone: () -> Void

	@State private var model: ComputerModel
	@State private var bridge = ComputerPageBridge()
	@Environment(\.dismiss) private var dismiss
	@Environment(\.scenePhase) private var scenePhase

	init(agentName: String, agentID: String?, environment: AppEnvironment, onDone: @escaping () -> Void) {
		self.agentName = agentName
		self.onDone = onDone
		_model = State(
			initialValue: ComputerModel(
				agentID: agentID, baseURL: environment.baseURL,
				connector: APIDesktopConnect(
					baseURL: environment.baseURL, clientSource: environment.clientSource,
					credentials: environment.auth.credentialsProvider)))
	}

	var body: some View {
		NavigationStack {
			VStack(spacing: MaskinSpace.s6) {
				screen
				status
			}
			.padding(.horizontal, MaskinSpace.s6)
			.frame(maxWidth: .infinity, maxHeight: .infinity)
			.background(MaskinSurface.grouped)
			.navigationTitle("\(agentName)'s computer")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Close") { dismiss() }
				}
			}
			.safeAreaInset(edge: .bottom) { controls }
		}
		.background {
			ComputerKeyCatcher(active: model.controlling, requests: model.keyboardRequests, bridge: bridge)
				.frame(width: 0, height: 0)
		}
		.task { model.startIfNeeded() }
		.onChange(of: scenePhase) { _, phase in
			if phase == .background { model.enteredBackground() }
		}
		.onDisappear { model.close() }
	}

	/// The picture and, on top of it, whatever the current state has to say.
	private var screen: some View {
		ZStack {
			ComputerWebView(
				stream: model.stream, controlling: model.controlling, bridge: bridge,
				onEvent: { model.handle($0) }
			)
			.opacity(model.phase == .live ? 1 : 0)
			overlay
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
		.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
	}

	@ViewBuilder private var overlay: some View {
		switch model.phase {
		case .starting:
			EmptyState(title: "This can take a moment", message: "The first start can take up to a minute.") {
				ProgressView()
			}
		case .connecting:
			EmptyState(title: "Almost there") { ProgressView() }
		case .live:
			EmptyView()
		case .idle:
			EmptyState(symbol: "moon.zzz", title: "The computer is idle") {
				Button("Wake up") { model.connect() }.buttonStyle(.secondaryAction)
			}
		case .failed(let message):
			EmptyState(symbol: "exclamationmark.triangle", title: "Couldn't open the desktop", message: message) {
				Button("Reconnect") { model.connect() }.buttonStyle(.secondaryAction)
			}
		}
	}

	private var status: some View {
		HStack(spacing: MaskinSpace.s3) {
			if model.phase == .starting || model.phase == .connecting {
				ProgressView().controlSize(.small)
			}
			Text(statusText).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityElement(children: .combine)
	}

	private var statusText: String {
		switch model.phase {
		case .starting: "Starting this computer…"
		case .connecting: "Connecting…"
		case .live: model.controlling ? "You're in control" : "Watching"
		case .idle: "The computer is idle"
		case .failed: "Not connected"
		}
	}

	private var controls: some View {
		VStack(spacing: MaskinSpace.s4) {
			if model.phase == .live {
				HStack(spacing: MaskinSpace.s4) {
					Button(model.controlling ? "Stop controlling" : "Take over") {
						model.setControlling(!model.controlling)
					}
					.buttonStyle(.secondaryAction)
					if model.controlling {
						Button("Keyboard") { model.showKeyboard() }.buttonStyle(.secondaryAction)
					}
				}
			}
			Button("Done") {
				onDone()
				dismiss()
			}
			.buttonStyle(.primaryAction)
		}
		.padding(.horizontal, MaskinSpace.s6)
		.padding(.bottom, MaskinSpace.s4)
		.background(MaskinSurface.grouped)
	}
}
#endif
