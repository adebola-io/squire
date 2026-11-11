# Squire plugin

Connects ChatGPT and Codex to Squire through Remote Access at
`https://use-squire.com/mcp`. The URL is injected when the package is built so a
development build can target a local site Worker instead. See `../../README.md`
for the packaging command.

## What Is In Here

```text
plugins/squire/
├── plugin.json                  # Portable Agent Plugins manifest (canonical)
├── mcp.json                     # Portable MCP server declaration (canonical)
├── .codex-plugin/plugin.json    # Codex compatibility manifest
├── .mcp.json                    # Codex compatibility MCP server declaration
├── assets/icon.png              # Marketplace logo
├── assets/composer-icon.png     # Composer icon
└── README.md
```

`plugin.json` plus `mcp.json` is the canonical form. `.codex-plugin/plugin.json`
and `.mcp.json` are the Codex compatibility form. Both MCP files carry the
templated `{{MCP_URL}}` placeholder; the packager fills it in.

## Connection

The MCP server is Squire's hosted Streamable HTTP endpoint, protected by OAuth
2.1 against the user's Squire account. Clients discover the authorization
endpoints from `https://use-squire.com/.well-known/`. While authorizing, the
user picks which of their computers the connection uses; that computer must
have Remote Access turned on. This plugin embeds no credentials and no API key.

## No Bundled Skills

This plugin bundles no skills.

## Version

`0.1.0`
