# Localhost previews

OpenBuild's browser panel proxies HTTP localhost URLs through the server running the project. Dev servers can stay bound to `127.0.0.1` or `::1`; users do not need `--host 0.0.0.0`. Links opened in an external tab use the same proxy.

Each preview gets a separate port on the OpenBuild host, preserving root asset paths, requests, redirects, and WebSocket hot reload. A signed-in user obtains a temporary bootstrap link that sets an HttpOnly preview cookie. Preview origins cannot access OpenBuild's origin, and OpenBuild cookies and authorization headers are stripped before forwarding. Upstream Set-Cookie headers are also stripped, so cookie-based project login is currently unsupported.

For paired projects, the browser connects to its usual OpenBuild host. That host forwards HTTP and WebSockets through the paired device's authenticated API; it never gives the device's bearer token to the browser. Both devices need this version of OpenBuild.

Preview listeners use ephemeral ports, limited to 32 concurrent previews, and expire after eight hours. Restarting OpenBuild closes them. Firewalls must permit the preview port on the OpenBuild host. The dev server port itself stays private.

Currently automatic previews support HTTP access to OpenBuild and HTTP localhost projects. HTTPS-only reverse proxies (including a TLS route forwarding only the main OpenBuild port) need an additional TLS preview route; this implementation does not provision that route. The panel reports this limitation when opened over HTTPS. Projects that hard-code their original localhost address for assets, APIs, or WebSockets may also need to use relative URLs.
