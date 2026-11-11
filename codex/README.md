# Squire plugin

The Squire plugin connects ChatGPT and Codex to Squire Remote Access over MCP at `https://use-squire.com/mcp`. Each authorization selects the computer to connect to.

## Packaging

From the repository root:

```sh
pnpm run package:codex-plugin
```

To use another MCP endpoint, pass `--mcp-url <url>` to `scripts/package-codex-plugin.sh` or set `SQUIRE_MCP_URL`.

The package is written to `dist/squire-codex-plugin-<version>.zip`, with a matching SHA-256 checksum. The archive contains:

```text
squire/
├── plugin.json
├── .codex-plugin/plugin.json
├── mcp.json
├── .mcp.json
├── assets/icon.png
├── assets/composer-icon.png
└── README.md
```

The plugin's MCP configuration is generated during packaging. OAuth discovery uses the service origin's `/.well-known/` endpoints.

## Publishing

For public distribution through ChatGPT, use the plugin submission flow described at https://developers.openai.com/plugins/deploy/submission.

## Version

Plugin `squire` `0.1.0`.
