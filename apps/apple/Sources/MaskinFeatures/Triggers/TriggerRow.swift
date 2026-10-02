import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One trigger in the list: kind glyph, name, a plain-language summary, the agent it runs, and an
/// inline on/off switch.
struct TriggerRow: View {
	let trigger: Trigger
	let agentName: String
	let onToggle: (Bool) -> Void

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s7) {
			Image(systemName: trigger.kind.symbol)
				.font(.system(size: MaskinSpace.s9, weight: .semibold))
				.foregroundStyle(trigger.enabled ? MaskinColor.accentFgStrong : MaskinColor.ink5)
				.frame(width: MaskinSpace.s14, height: MaskinSpace.s14)
				.background(
					trigger.enabled ? MaskinColor.accentTint2 : MaskinSurface.fill,
					in: RoundedRectangle(cornerRadius: MaskinRadius.panel, style: .continuous)
				)
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				Text(trigger.name)
					.maskinText(.headline)
					.foregroundStyle(trigger.enabled ? MaskinColor.ink : MaskinColor.ink4)
					.lineLimit(2)
				Text(trigger.summary)
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.ink4)
					.lineLimit(2)
				HStack(spacing: MaskinSpace.s3) {
					ActorAvatar(name: agentName, kind: .agent, size: MaskinSpace.s10, seed: trigger.targetActorID)
					Text(agentName).maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(1)
				}
				.accessibilityHidden(true)
			}
			Spacer(minLength: MaskinSpace.s3)
			Toggle(
				"Enabled",
				isOn: Binding(get: { trigger.enabled }, set: onToggle)
			)
			.labelsHidden()
			.accessibilityLabel("\(trigger.name) enabled")
		}
		.padding(.vertical, MaskinSpace.s2)
		.contentShape(Rectangle())
		.accessibilityElement(children: .contain)
	}
}
