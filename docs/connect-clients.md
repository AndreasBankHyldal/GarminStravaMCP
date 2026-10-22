# Using the hosted Garmin MCP server from any computer

Once the server runs on the VM (see [hosting-oracle.md](hosting-oracle.md)), every computer
connects to the same endpoint. A client machine needs **no** repository checkout, Garmin password,
Garmin tokens or `git pull`. The server updates itself on every push to `main`.

You need:

- the endpoint, `https://your-name.duckdns.org/mcp`
- your access token: the owner's `MCP_AUTH_TOKEN` from `~/GarminStravaMCP/.env` on the VM, or the
  personal token the admin created for you
- for Claude Desktop only: [Node.js](https://nodejs.org) 18 or newer, which provides `npx`

The token decides **whose** Garmin data you see. If you're not the owner, follow the beginner-friendly
[getting-started.md](getting-started.md) instead. It covers uploading your Garmin session and the
most common apps.

Keep the MCP server name **`garmin`** in every client. The Copilot fitness canvas and the routing
instructions recognise Garmin tools by that prefix.

## 1. Get the token once and store it safely

Save the token in a password manager so every computer can reach it. Never commit it, put it in an
issue, or paste it into a chat. Personal tokens are shown once by the admin's `users add`; if you
lose yours, ask for a new one (`users rotate`). The owner can read theirs in two ways:

```bash
# From the VM (needs your Oracle SSH key on this computer):
ssh -i ~/.ssh/oracle_garmin ubuntu@<public-ip> "grep '^MCP_AUTH_TOKEN=' ~/GarminStravaMCP/.env | cut -d= -f2"

# From a Mac where Claude Desktop already uses the hosted server (copies it to the clipboard):
python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/Library/Application Support/Claude/claude_desktop_config.json')))['mcpServers']['garmin']['env']['GARMIN_MCP_AUTH'].split(' ',1)[1],end='')" | pbcopy
```

**Rotating the token:** on the VM, replace `MCP_AUTH_TOKEN` in `.env` with a new
`openssl rand -hex 32` value, run `docker compose up -d`, then update every client.

## 2. Claude Desktop (macOS and Windows)

Claude Desktop can't send a custom header itself, so it connects through the `mcp-remote` bridge.

1. Install Node.js LTS if `npx --version` doesn't work.
2. Open the config with **Settings → Developer → Edit Config**, or directly:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
3. Add the `garmin` entry under `mcpServers`, keeping any other servers. Remove old local Garmin
   entries (for example `strava-garmin` pointing at `dist/index.js`) so the tools don't appear twice.

   ```json
   {
     "mcpServers": {
       "garmin": {
         "command": "npx",
         "args": ["-y", "mcp-remote", "https://your-name.duckdns.org/mcp", "--header", "Authorization:${GARMIN_MCP_AUTH}"],
         "env": { "GARMIN_MCP_AUTH": "Bearer <TOKEN>" }
       }
     }
   }
   ```

   Keep `Authorization:${GARMIN_MCP_AUTH}` without a space; the space lives inside the env value.
4. Quit Claude Desktop completely (**Cmd+Q**, or *Quit* from the Windows tray icon) and reopen it.

The file now contains the token. On macOS, restrict it with
`chmod 600 ~/Library/Application\ Support/Claude/claude_desktop_config.json`.

## Claude (web & iPhone)

The server must be reachable over **HTTPS**; your phone connects to the hosted server,
not a local stdio process. Existing desktop bearer-token configurations still work.

On the server, set these in `.env` and restart/recreate the HTTP service:

```dotenv
MCP_OAUTH_ISSUER_URL=https://your-name.duckdns.org
MCP_ALLOWED_HOSTS=your-name.duckdns.org
```

With the supplied Docker Compose deployment, `MCP_PUBLIC_HOST` sets the allowed host;
run `docker compose up -d` after updating `.env`. Keep the application port private
behind the HTTPS reverse proxy. Set `MCP_TRUST_PROXY=true` only when requests can come
only through a trusted proxy that replaces `X-Forwarded-For`.

1. On **claude.ai**, open **Settings → Connectors → Add custom connector**.
2. Name it `garmin` and enter `https://your-name.duckdns.org/mcp`.
3. In the server's login page, paste your **existing access token** from your password
   manager (the owner's `MCP_AUTH_TOKEN`, or your personal token from `users add`).
   Review the consent notice and approve. Never paste it into the Claude chat or a URL.
   Submit within **5 minutes**, and keep the authorization page in the same browser
   while retrieving the token. Paste only the token, without a `Bearer` prefix.
4. The connector is then available in the Claude iPhone app when signed into the same
   Claude account. Enable it in the conversation if needed.
5. Ask Claude to call **`whoami`**. It returns `userId` and `garminSessionPresent`.
   This checks for saved session files, not whether Garmin still accepts them. Confirm
   with “Show my last Garmin activity” and compare with Garmin Connect.

The token determines which user's Garmin session and database the connector can use.
The server address alone grants no access. Other users need their own tokens and get
their own data. OAuth does not upload a Garmin session: follow
[getting-started.md](getting-started.md) if your session is missing.

### Revoking access (for example, a lost phone)

Run on the server to revoke **all OAuth connections for that user**, without changing
their static desktop token or deleting their Garmin data:

```bash
docker compose exec app node dist/users/cli.js revoke-oauth owner
# Or replace owner with a personal user id:
docker compose exec app node dist/users/cli.js revoke-oauth alice
```

For a non-Docker installation, use `npm run users -- revoke-oauth <id>` with the same
state directory as the running server. Revocation takes effect without a restart;
reconnecting requires logging in again. If the original access token was also exposed,
rotate it (`users rotate <id>`, or change `MCP_AUTH_TOKEN` and restart for the owner).
Rotating/removing a user's static credential invalidates their OAuth grants too.
Clients can also revoke their own issued tokens using `POST /revoke`.

### OAuth configuration

| Variable | Meaning |
|---|---|
| `MCP_OAUTH_ISSUER_URL` | Public HTTPS origin, without `/mcp`, query, or fragment. Enables OAuth; unset keeps static-bearer-only mode. Plain HTTP is permitted only for loopback development. |
| `MCP_OAUTH_REDIRECT_URIS` | Optional comma-separated **exact** additional trusted callback URLs. `https://claude.ai/api/mcp/auth_callback` is always allowed. No wildcards; HTTPS required except loopback HTTP. |

Discovery, registration, authorization, token and revocation endpoints are served at
the issuer origin. Keep them accessible through the proxy, not just `/mcp`.
OAuth state is stored in `oauth.json` under the configured state directory; keep it persistent
and do not publish or commit it. Access tokens expire after 15 minutes. Refresh tokens
rotate on every use and expire 30 days after login, when you must connect again.
Treat all access tokens as passwords. Leave women's-health tools disabled over HTTP
unless explicitly needed.

### Troubleshooting Claude authorization

If submission fails, read the response's `error_description`. The server also writes
a token-free reason to the **app** service logs:

```bash
docker compose logs --since=10m app
```

The Caddy startup/certificate-renewal logs do not explain an OAuth consent rejection.
Do not share `.env`, access tokens, cookies, or full authorization/callback URLs.

| Reason | What to do |
|---|---|
| `session_expired` | Start a fresh connection from Claude and submit within 5 minutes. Pending forms also become invalid after an app restart/deployment or successful use. |
| `cookie_missing` / `browser_mismatch` | Allow cookies and restart the connection in the same browser. Do not move an open consent form between Safari, a private window, and an in-app browser. |
| `csrf_mismatch` / `invalid_form` / `invalid_request_body` | Start a fresh connection from Claude rather than reusing or editing an old authorization URL/form. |
| `invalid_token` (`access_denied`, HTTP 401) | Go back and correct the MCP access token. It is not your Garmin password, Garmin session token, or an OAuth client secret. A failed submission does not consume an otherwise valid form. |
| `invalid_origin` / `invalid_authorization_request` | Start from the connector in Claude. Check that the public issuer and callback configuration match the endpoint. |
| `server_error` (HTTP 500) | Check the app service and its persistent state directory for storage/permission problems. This is a server failure, not a bad access token. |

Opening another authorization page in the same browser no longer replaces the browser
binding of an existing form. Each form still requires its own CSRF value and explicit
consent, expires after 5 minutes, and can succeed only once. The consent page's form
policy permits the selected trusted callback origin so browsers can follow the OAuth
redirect back to Claude.

## 3. GitHub Copilot desktop app and Copilot CLI

Both read `~/.copilot/mcp-config.json` (Windows: `%USERPROFILE%\.copilot\mcp-config.json`). Add,
or replace, the `garmin` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "garmin": {
      "type": "http",
      "url": "https://your-name.duckdns.org/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" },
      "tools": ["*"]
    }
  }
}
```

Restart the app, or start a new CLI session.

**Optional fitness canvas.** The interactive Garmin dashboard in the Copilot desktop app is a local
extension, but it only displays results, so it works with the hosted server too. To install it on a
new computer:

```bash
git clone https://github.com/AndreasBankHyldal/GarminStravaMCP.git
cd GarminStravaMCP
npm ci && npm run install:copilot
```

This needs no `.env` or Garmin tokens. Rerun it after pulling changes to the dashboard.

## 4. VS Code (GitHub Copilot Chat)

Run **MCP: Open User Configuration** from the Command Palette and add:

```json
{
  "inputs": [
    { "type": "promptString", "id": "garmin-mcp-token", "description": "Garmin MCP token", "password": true }
  ],
  "servers": {
    "garmin": {
      "type": "http",
      "url": "https://your-name.duckdns.org/mcp",
      "headers": { "Authorization": "Bearer ${input:garmin-mcp-token}" }
    }
  }
}
```

VS Code asks for the token the first time and stores it securely. With Settings Sync on, the
config follows you to other computers and each one asks for the token once.

## 5. Claude Code

```bash
claude mcp add --transport http --scope user garmin https://your-name.duckdns.org/mcp \
  --header "Authorization: Bearer <TOKEN>"
```

`--scope user` makes it available in every project on that computer.

## 6. Check it works

```bash
curl -s https://your-name.duckdns.org/healthz    # {"status":"ok"}
```

Then ask the client: *"Show my last 2 Garmin activities."*

| Symptom | Cause and fix |
|---|---|
| HTTP 401 | Wrong token, or `Bearer ` missing in front of it. |
| HTTP 429 *Too many failed authentication attempts* | 10 wrong tokens within 15 minutes from this IP. Wait 15 minutes, then fix the token. |
| HTTP 403 *Host not allowed* | The URL host differs from `MCP_PUBLIC_HOST` on the VM. |
| Tool error mentioning Garmin 429 / copy tokens | The **server's** Garmin tokens are missing or expired, so a client change won't help. Renew them as described in [hosting-oracle.md §2](hosting-oracle.md#2-garmin-gono-go-and-token-bootstrap-phase-0). |
| Claude Desktop shows no Garmin tools | `npx` not found by the app, or a JSON syntax error. Check `~/Library/Logs/Claude/mcp-server-garmin.log` (macOS) or `%APPDATA%\Claude\logs` (Windows). |
| Tools appear twice | A local `dist/index.js` Garmin entry is still configured. Remove it. |

Women's-health tools aren't exposed over HTTP unless the server sets
`MCP_HTTP_ALLOW_WOMEN_TOOLS=true`.
