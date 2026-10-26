import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// An agent intro's first steps as buttons (the web's `SuggestedSteps`), stacked at every width.
/// An arrow-up step sends its label as your message on one tap; a pencil step fills the message
/// box and sends nothing. What a send step sends is exactly what it prints, so a tap never puts
/// words in your mouth.
struct IntroStepsView: View {
	let steps: [AgentIntroView.Step]
	let onSend: (AgentIntroView.Step, Int) -> Void
	let onFill: (String) -> Void
	/// Set once a send step is tapped, so a second tap in the same moment cannot post twice.
	@State private var tapped = false

	var body: some View {
		VStack(spacing: MaskinSpace.s4) {
			ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
				Button {
					MaskinHaptics.play(.light)
					if step.sends {
						guard !tapped else { return }
						tapped = true
						onSend(step, index)
					} else {
						onFill(step.prompt)
					}
				} label: {
					HStack(spacing: MaskinSpace.s5) {
						Image(systemName: step.sends ? "arrow.up" : "pencil")
							.font(.footnote).foregroundStyle(MaskinColor.ink4).accessibilityHidden(true)
						Text(step.label + (step.sends ? "" : "…"))
							.maskinText(.subhead).fontWeight(.medium).foregroundStyle(MaskinColor.ink)
							.multilineTextAlignment(.leading).lineLimit(2)
						Spacer(minLength: 0)
					}
					.padding(.horizontal, MaskinSpace.s6)
					.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin, alignment: .leading)
					.background(
						MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
					)
					.overlay(
						RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
							.strokeBorder(MaskinSurface.line, lineWidth: 1))
				}
				.buttonStyle(.maskinPressed(.shrink))
				.disabled(tapped && step.sends)
				.accessibilityLabel(
					"\(step.label)\(step.sends ? "" : "…"), \(step.sends ? "sends now" : "fills the message box")")
			}
		}
		.padding(.top, MaskinSpace.s3)
		.accessibilityElement(children: .contain)
	}
}

/// The tools an agent's intro says the job needs, one row each (3 at most, in the writer's order).
/// Status is read live rather than stored on the message, so a scrolled-back intro never shows a
/// stale button. A missing tool is the Connect card; once every one is connected it collapses to
/// one line. Whether the agent itself has the tool (the web's "set up the agent's tools" hint) is
/// not shown yet.
struct IntroToolsView: View {
	let providers: [String]
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var store: IntegrationsStore?

	var body: some View {
		Group {
			if let store, store.phase == .loaded {
				let known = providers.compactMap { store.provider(for: $0) }
				if !known.isEmpty {
					if known.allSatisfy({ isConnected($0.id, store) }) {
						RequestCardSettled(
							symbol: "checkmark.circle.fill",
							text: "Connected: " + known.map(\.displayName).joined(separator: ", "))
					} else {
						VStack(alignment: .leading, spacing: MaskinSpace.s2) {
							Text("TOOLS FOR THIS JOB").maskinText(.microLabel).foregroundStyle(MaskinColor.ink4)
							ForEach(known) { provider in
								IntegrationConnectCard(request: IntegrationConnectRequest(provider: provider.id), store: store)
							}
						}
					}
				}
			}
		}
		.padding(.top, MaskinSpace.s3)
		.task {
			guard store == nil, let runtime else { return }
			let made = SettingsServices(environment: runtime.environment).integrationsStore()
			store = made
			await made.load()
		}
	}

	private func isConnected(_ provider: String, _ store: IntegrationsStore) -> Bool {
		store.connected.contains { $0.provider == provider && $0.state == .connected }
	}
}
