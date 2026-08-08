import Foundation

/// Points the app at the `apps/dev` backend during local development.
///
/// `localhost` is the correct default — it works from the iOS Simulator (which shares
/// the Mac's network stack) and is the common case. A physical device needs the Mac's
/// LAN IP instead (run `ipconfig getifaddr en0` on the Mac to find it); edit `host`
/// locally when testing on-device, but don't commit a personal IP here — this is a
/// multi-tenant OSS repo and every contributor's network is different. Requires the
/// phone and Mac on the same network, and `pnpm dev`'s server to accept non-loopback
/// connections (Hono's `serve()` binds `0.0.0.0` by default).
enum DevServer {
	static let host = "localhost"
	static let port = 3000

	static var apiBaseURL: URL { URL(string: "http://\(host):\(port)/api")! }
	static var eventsURL: URL { URL(string: "http://\(host):\(port)/api/events")! }
}
