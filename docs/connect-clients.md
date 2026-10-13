# Using the hosted Garmin MCP server from any computer

Once the server runs on the VM (see [hosting-oracle.md](hosting-oracle.md)), every computer
connects to the same endpoint. A client machine needs **no** repository checkout, Garmin password,
Garmin tokens or `git pull`. The server updates itself on every push to `main`.

You need:

- the endpoint, `https://your-name.duckdns.org/mcp`
- the access token, the `MCP_AUTH_TOKEN` value from `~/GarminStravaMCP/.env` on the VM
- for Claude Desktop only: [Node.js](https://nodejs.org) 18 or newer, which provides `npx`

Keep the MCP server name **`garmin`** in every client. The Copilot fitness canvas and the routing
instructions recognise Garmin tools by that prefix.

## 1. Get the token once and store it safely

Save the token in a password manager so every computer can reach it. Never commit it, put it in an
issue, or paste it into a chat. Two ways to read it:

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
