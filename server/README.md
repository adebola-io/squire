# Squire Server

This is the Squire server: the agent, its tools, the local chat UI, and the
outbound Remote Access connection. It runs no MCP server or tool API of its
own; external MCP clients reach it only through hosted Remote Access
(`src/remote/`). It uses the Rust MCP SDK (`rmcp`) only as a client, for
plugins backed by MCP servers.

Run:

```bash
cargo run
```

Runtime settings are loaded from `~/.squire/settings.json` unless `SQUIRE_HOME` is set. If the file is missing, Squire creates it with local defaults.

Squire listens on one loopback port, `ports.web` in `settings.json`
(default `4296`): the local web UI, with no login.

Roots live in `squire.db`.

## Link a Squire account (development)

Account enrollment is implemented in Rust and exposed through the local
desktop API. It does not require Retend GPUI. Open the local Squire control
page at `http://127.0.0.1:4296/`, then use the browser console:

```js
const response = await fetch("/desktop/account/connect", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
const enrollment = await response.json();
console.log(enrollment.approvalUrl); // Open this URL and approve the installation.
```

After approval, inspect status or check hosted token renewal (the token itself
is never returned to browser code):

```js
await fetch("/desktop/account").then((response) => response.json());
await fetch("/desktop/account/verify", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
}).then((response) => response.json()); // { authorized: true }
```

To cancel a pending enrollment or revoke a connected installation:

```js
await fetch("/desktop/account/disconnect", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
}).then((response) => response.json());
```

Private installation credentials are stored in the local SQLite secrets table,
not in the browser or settings JSON. On Unix, Squire restricts its home
directory and database permissions to the owning user.

## Hosted service

Squire talks to one hosted service, the site Worker, for account linking,
titles, web search and the marketplace. `SQUIRE_SERVICE_URL` says where it is,
the same way in every build. Without an environment override, the server
defaults to `https://use-squire.com` for installed/production use.
The server loads a repository-root `.env` file when started from that
directory; copy `.env.example` to `.env` for local development, which sets
`SQUIRE_SERVICE_URL=http://localhost:5212`. An explicitly exported environment
variable takes precedence over the file. Plain `http://` is accepted only
for localhost. Start a compatible local Worker separately when working
with the local marketplace.

## Background actions

`limits.commandTimeoutMs` controls the foreground wait for `use_action` and
`check_job`, defaulting to 30 seconds. Actions that outlast it return a `job`
object and continue up to `limits.actionMaxRuntimeMs`, which defaults to 20 minutes.
Call `check_job` with the job id to wait for its result, or `cancel_job` to stop it.

Jobs are accessible from any session. Deleting their originating session cancels
and removes them. Deleting a plugin also cancels its active actions. Shutdown
interrupts active actions, and startup records interruption for unfinished rows.
Completed results remain cached for 15 minutes, then checks read the activity record.
