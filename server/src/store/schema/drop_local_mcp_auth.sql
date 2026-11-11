-- Squire is reached only through the chat UI and hosted Remote Access, so the
-- local MCP server's OAuth clients and its bearer tokens are gone.
DROP TABLE oauth_clients;
DROP TABLE auth_tokens;
