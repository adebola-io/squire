# Squire

Squire is a personal coding agent with scoped access to project folders, a local chat interface, browser automation, and plugins. It runs on your computer and can connect to external MCP clients through [Squire Remote Access](https://use-squire.com).

## Install

On macOS and Linux, including Termux:

```sh
curl -fsSL https://use-squire.com/install.sh | sh
```

On Windows PowerShell:

```powershell
irm https://use-squire.com/install.ps1 | iex
```

The installer verifies the download's SHA-256 checksum and adds Squire to your PATH. It does not start Squire automatically.

Run it with:

```sh
squire
```

Squire opens its local UI in your browser. To run it as a user service, use `squire service install`; use `squire service status` to inspect it.

## Development

Requirements: stable Rust, Node.js 22, pnpm 10, CMake and a C/C++ compiler. Linux also needs clang and libclang development headers.

```sh
pnpm install --frozen-lockfile
pnpm run dev
```

The application UI is served on localhost (4296 by default). Vite development uses localhost:4295.

Build a production binary:

```sh
pnpm run build:release
```

## Project layout

- `server/` — Rust server, agent runtime, local API, browser control, plugin host and Remote Access client
- `packages/web/` — Retend browser UI
- `packages/ui/` — shared interface components
- `packages/markdown/` — Markdown rendering
- `wit/` — WebAssembly plugin interface definitions
- `codex/` — plugin package metadata
- `scripts/` — development and packaging scripts

Settings are stored in `~/.squire/settings.json`. `SQUIRE_HOME` overrides this location; see [settings.example.json](settings.example.json).

## Remote Access and plugins

Squire supports WebAssembly plugins and MCP servers over local stdio or Streamable HTTP. The plugin marketplace is available from the app.

Remote Access connects to [use-squire.com](https://use-squire.com) using an authenticated outbound connection, allowing approved MCP clients to reach your agent without exposing the local UI. The local UI has no login, so only expose it to origins you trust. See [server/README.md](server/README.md) for additional configuration details.

## License

Squire is licensed under the [Functional Source License, Version 1.1, Apache 2.0 Future License](LICENSE.md) (`FSL-1.1-Apache-2.0`). Each version becomes available under Apache 2.0 two years after publication.

Third-party libraries and assets retain their own licenses; see license files in their respective directories.
