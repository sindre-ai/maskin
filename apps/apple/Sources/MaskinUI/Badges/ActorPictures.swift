import SwiftUI

/// Where an actor's uploaded picture is served, and the letters it chose for its avatar. `MainShell`
/// provides both from the workspace's actor list; without a shell (previews, tests) no actor has
/// either, and `ActorAvatar` draws the automatic initials.
public struct ActorPictures: Sendable {
	/// The picture's address for an actor id, or nil when the actor has none.
	public var url: @MainActor @Sendable (String) -> URL?
	/// The letters the actor chose for its avatar, or nil when it has set none.
	public var initials: @MainActor @Sendable (String) -> String?

	public init(
		url: @escaping @MainActor @Sendable (String) -> URL?,
		initials: @escaping @MainActor @Sendable (String) -> String? = { _ in nil }
	) {
		self.url = url
		self.initials = initials
	}

	public static let none = ActorPictures { _ in nil }
}

private struct ActorPicturesKey: EnvironmentKey {
	static let defaultValue = ActorPictures.none
}

extension EnvironmentValues {
	public var actorPictures: ActorPictures {
		get { self[ActorPicturesKey.self] }
		set { self[ActorPicturesKey.self] = newValue }
	}
}
