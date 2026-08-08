import Foundation

/// Points the app at the `apps/dev` backend during local development.
///
/// The standard workflow is testing on a physical device, which needs your Mac's LAN
/// IP here (run `ipconfig getifaddr en0` on the Mac to find it) — requires the phone
/// and Mac on the same network, and `pnpm dev`'s server to accept non-loopback
/// connections (Hono's `serve()` binds `0.0.0.0` by default). Edit `host` locally for
/// your network; don't commit a personal IP here — this is a multi-tenant OSS repo and
/// every contributor's network is different, which is why the shipped default is the
/// inert `localhost` rather than anyone's real address.
///
/// Testing in the Simulator instead: leave `host` as `localhost` — the Simulator
/// shares the Mac's network stack, so no edit is needed.
enum DevServer {
	static let host = "localhost"
	static let port = 3000

	static var apiBaseURL: URL { URL(string: "http://\(host):\(port)/api")! }
	static var eventsURL: URL { URL(string: "http://\(host):\(port)/api/events")! }
}
