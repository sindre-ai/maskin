import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Ask an agent to start a run now, optionally telling it what to do.
struct RunAgentSheet: View {
	let agentName: String
	/// Returns whether the run was accepted; the sheet stays open (keeping the prompt) if not.
	let onRun: (String?) async -> Bool

	@Environment(\.dismiss) private var dismiss
	@State private var prompt = ""
	@State private var isRunning = false

	var body: some View {
		NavigationStack {
			Form {
				Section {
					TextField("What should it do?", text: $prompt, axis: .vertical)
						.lineLimit(3...10)
				} footer: {
					Text("Leave empty to run \(agentName) with its usual instructions.")
				}
			}
			.navigationTitle("Run \(agentName)")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Run") { Task { await run() } }.disabled(isRunning)
				}
			}
			.overlay { if isRunning { ProgressView() } }
		}
	}

	private func run() async {
		isRunning = true
		defer { isRunning = false }
		if await onRun(prompt) {
			MaskinHaptics.play(.success)
			dismiss()
		} else {
			MaskinHaptics.play(.error)
		}
	}
}
