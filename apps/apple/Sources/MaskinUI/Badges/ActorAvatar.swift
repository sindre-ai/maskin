import MaskinDesign
import SwiftUI

/// Pure identity logic for avatars, kept apart from the view so it can be tested.
public enum ActorIdentity {
	/// Up to two letters: first letters of the first two words, or the first two of a single
	/// word. Punctuation and bracketed qualifiers never reach the glyph. "?" when empty.
	public static func initials(for name: String) -> String {
		let words = name.split(whereSeparator: \.isWhitespace).map {
			String($0.filter { $0.isLetter || $0.isNumber })
		}.filter { !$0.isEmpty }
		switch words.count {
		case 0: return "?"
		case 1:
			let word = words[0]
			return String(word.prefix(2)).uppercased()
		default:
			return (String(words[0].prefix(1)) + String(words[1].prefix(1))).uppercased()
		}
	}

	/// djb2-xor, identical to the web's `hashString`, so a given actor gets the same colour
	/// on every client. (Swift's `hashValue` is randomised per process, so it cannot be used.)
	public static func bucketHash(_ input: String) -> UInt32 {
		var hash: UInt32 = 5381
		for unit in input.utf16 {
			hash = ((hash << 5) &+ hash) ^ UInt32(unit)
		}
		return hash
	}

	/// The web's ten human-avatar identities, as `--st-*` token keys.
	static let humanPaletteKeys = [
		"in_progress", "active", "signal", "clustered", "in_review",
		"validated", "qualified", "scored", "processing", "proposed",
	]
	static let agentPalette: [MaskinColorPair] = [
		MaskinColorPair(bg: MaskinColor.agentRelayTint, fg: MaskinColor.agentRelayFg),
		MaskinColorPair(bg: MaskinColor.agentCompassTint, fg: MaskinColor.agentCompassFg),
		MaskinColorPair(bg: MaskinColor.agentForgeTint, fg: MaskinColor.agentForgeFg),
		MaskinColorPair(bg: MaskinColor.agentSentinelTint, fg: MaskinColor.agentSentinelFg),
		MaskinColorPair(bg: MaskinColor.agentQuillTint, fg: MaskinColor.agentQuillFg),
	]

	public static func paletteIndex(seed: String, kind: ActorAvatar.Kind) -> Int {
		let count = kind == .agent ? agentPalette.count : humanPaletteKeys.count
		return Int(bucketHash(seed.isEmpty ? "?" : seed) % UInt32(count))
	}

	static func colors(seed: String, kind: ActorAvatar.Kind) -> MaskinColorPair {
		let i = paletteIndex(seed: seed, kind: kind)
		switch kind {
		case .agent: return agentPalette[i]
		case .human: return MaskinStatus.colors(for: humanPaletteKeys[i])
		}
	}
}

/// Round avatar showing initials on a stable per-actor tint. Agents use the `agent-*`
/// identity swatches, humans the web's ten-colour palette.
public struct ActorAvatar: View {
	public enum Kind: Sendable { case human, agent }

	private let name: String
	private let kind: Kind
	private let size: CGFloat
	private let seed: String
	private let working: Bool

	/// - Parameters:
	///   - seed: stable id for colour selection (defaults to the name).
	///   - working: show the violet "agent is running" ring.
	public init(
		name: String, kind: Kind = .human, size: CGFloat = MaskinSpace.s12 + MaskinSpace.s3 + MaskinSpace.s3,
		seed: String? = nil, working: Bool = false
	) {
		self.name = name
		self.kind = kind
		self.size = size
		self.seed = seed ?? name
		self.working = working
	}

	public var body: some View {
		let colors = ActorIdentity.colors(seed: seed, kind: kind)
		Text(ActorIdentity.initials(for: name))
			.font(MaskinTypeface.sans(size * 0.4, weight: .semibold, relativeTo: .caption))
			.minimumScaleFactor(0.6)
			.foregroundStyle(colors.fg)
			.frame(width: size, height: size)
			.background(colors.bg, in: Circle())
			.overlay {
				if working { Circle().strokeBorder(MaskinColor.accent, lineWidth: MaskinSpace.s1) }
			}
			.accessibilityElement(children: .ignore)
			.accessibilityLabel(working ? "\(name), working" : name)
	}
}

#Preview("Avatars — light") { AvatarGallery().preferredColorScheme(.light) }
#Preview("Avatars — dark") { AvatarGallery().preferredColorScheme(.dark) }

private struct AvatarGallery: View {
	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			HStack {
				ForEach(["Sindre Ahl", "Magnus", "Linker (Sigrid)", ""], id: \.self) { ActorAvatar(name: $0) }
			}
			HStack {
				ForEach(["Relay", "Compass", "Forge", "Sentinel", "Quill"], id: \.self) {
					ActorAvatar(name: $0, kind: .agent)
				}
				ActorAvatar(name: "Forge", kind: .agent, working: true)
			}
		}
		.padding(MaskinSpace.s9)
		.background(MaskinSurface.grouped)
	}
}
