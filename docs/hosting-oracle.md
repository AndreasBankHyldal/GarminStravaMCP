# Hosting on Oracle Cloud (Always Free)

This guide runs the MCP server 24/7 on a free Oracle Cloud VM. It serves Streamable HTTP with
bearer-token auth behind Caddy, with automatic HTTPS on a free DuckDNS hostname, and deploys on
every push to `main`. Local stdio use doesn't change.

The full plan and its rationale are in issue #11; the Oracle setup log is in #12.

```
MCP client ──HTTPS──▶ Caddy (:443, Let's Encrypt) ──▶ app container (:3000, /mcp + /healthz)
                                                         └─ /data  ⇐ ~/GarminStravaMCP/state
```

## 1. Oracle VM (Phase 1)

1. Sign up and pick a home region. It can't be changed later. A brand-new tenancy can take a while
   to work: if every create request fails with *"Authorization failed or requested resource not
   found"*, the platform image list is empty, or you can't even list policies in the root
   compartment, open a service request instead of retrying. That's how #12 was resolved.
2. **Network first:** Networking → Virtual cloud networks → **Start VCN Wizard → Create VCN with
   Internet Connectivity**. Use a name with only letters and digits, for example `garminvcn`.
3. **Instance:** Compute → Instances → Create instance.
   - Shape `VM.Standard.A1.Flex` with 1 OCPU and 6 GB (Always Free). If you get "Out of capacity",
     try another availability domain or try again later.
   - Image **Canonical Ubuntu 24.04** (not *Minimal*). With the A1 shape, the aarch64 build is used.
   - Shielded instance and confidential computing off.
   - Existing VCN, **public** subnet, **Automatically assign public IPv4 address** on.
   - **Paste public key**: one line from `~/.ssh/<key>.pub` on the machine you connect from.
4. Connect: `ssh -i ~/.ssh/<key> ubuntu@<public-ip>`. Type the IP without `< >`.
5. Clone the repository on the VM. Everything below, including CI deploys, assumes
   `~/GarminStravaMCP` is a git checkout:

   ```bash
   sudo apt update && sudo apt install -y git
   git clone https://github.com/AndreasBankHyldal/GarminStravaMCP.git ~/GarminStravaMCP
   ```

Optional: convert the ephemeral public IP to a *reserved* public IP, so the DuckDNS record never
has to change.

## 2. Garmin go/no-go and token bootstrap (Phase 0)

Garmin rate-limits **fresh logins** from datacenter IPs. From Oracle, `npm run garmin-auth` got
past the password step and then failed with `HTTP 429 Too Many Requests` at the OAuth1 token
exchange. **Token refresh and all data calls work fine** from the VM. So log in at home and copy
the tokens across:

```bash
# On your own machine, in a local checkout with .env filled in:
npm run garmin-auth

# Copy the tokens into the server's state directory:
ssh -i ~/.ssh/<key> ubuntu@<public-ip> 'mkdir -p ~/GarminStravaMCP/state/.garmin-tokens && chmod 700 ~/GarminStravaMCP/state/.garmin-tokens'
scp -i ~/.ssh/<key> .garmin-tokens/oauth1_token.json .garmin-tokens/oauth2_token.json \
  ubuntu@<public-ip>:~/GarminStravaMCP/state/.garmin-tokens/
```

The OAuth1 token lasts about a year. Repeat this when it expires; the server's error message points
here when it does. **Don't loop logins from the VM.** Repeated failures can lock the Garmin
account, and the server already enforces a 60 s login cooldown.

To verify Garmin access from the VM without Docker, install Node 24
(`curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs build-essential python3`),
then in `~/GarminStravaMCP` create `.env` with your Garmin credentials, run
`npm ci && npm run build:server`, and call one tool using the copied tokens:

```bash
GARMIN_STATE_DIR=state npx @modelcontextprotocol/inspector --cli node dist/index.js \
  --method tools/call --tool-name garmin_get_activities
```

## 3. DuckDNS hostname and open ports (Phase 4, Caddy route)

1. Sign in at [duckdns.org](https://www.duckdns.org), create a subdomain such as
   `your-name.duckdns.org`, and set its IP to the VM's public IP.
2. **OCI security list:** Networking → Virtual cloud networks → `garminvcn` → Security →
   *Default Security List for garminvcn* → **Add Ingress Rules**. Add source `0.0.0.0/0`, protocol
   TCP, destination port `80`, then the same again for `443`. SSH (22) is already open.
3. **VM firewall:** Oracle's Ubuntu images use iptables rules from `/etc/iptables/rules.v4` (not
   ufw). Open the ports and persist them **before** installing Docker, so Docker's own rules don't
   end up in the saved file:

   ```bash
   sudo iptables -I INPUT -p tcp -m multiport --dports 80,443 -m conntrack --ctstate NEW -j ACCEPT
   sudo netfilter-persistent save
   ```

Caddy requests the Let's Encrypt certificate on first start, so DNS and both ports must be ready by
then.

## 4. Docker deployment (Phase 3)

Install Docker Engine and the compose plugin from
[Docker's apt repository](https://docs.docker.com/engine/install/ubuntu/), then:

```bash
sudo usermod -aG docker ubuntu   # log out and back in; docker group membership is root-equivalent
cd ~/GarminStravaMCP
git pull
mkdir -p state/.garmin-tokens && chmod 700 state state/.garmin-tokens
# Tokens from an earlier non-Docker test can be moved: mv .garmin-tokens/*.json state/.garmin-tokens/
cp .env.example .env && chmod 600 .env
nano .env
```

Set at least:

```dotenv
GARMIN_USERNAME=you@example.com
GARMIN_PASSWORD=...
MCP_AUTH_TOKEN=<output of: openssl rand -hex 32>
MCP_PUBLIC_HOST=your-name.duckdns.org
```

The container must run as the user that owns `./state`. On Oracle's Ubuntu image `ubuntu` is
uid/gid **1001**, not 1000, so append them to `.env`:

```bash
echo "APP_UID=$(id -u)" >> .env && echo "APP_GID=$(id -g)" >> .env
```

`docker-compose.yml` sets `MCP_TRANSPORT=http`, `MCP_HOST=0.0.0.0` inside the container,
`GARMIN_STATE_DIR=/data`, `MCP_ALLOWED_HOSTS=$MCP_PUBLIC_HOST` and `MCP_TRUST_PROXY=true`.
Start everything:

```bash
docker compose up -d --build
docker compose ps                         # app should become "healthy"
curl -s http://127.0.0.1:3000/healthz     # {"status":"ok"}
curl -s https://your-name.duckdns.org/healthz
docker compose logs -f app
```

Notes:

- `./state` on the host is mounted at `/data`. Tokens live in `state/.garmin-tokens/` and the
  database in `state/data/training.db`. The container runs as `APP_UID:APP_GID` (default
  1000:1000), so files copied with `scp` as that user stay readable. A mismatch shows up as
  "Permission denied" on `/data` and a Garmin login attempt (429) because no tokens are found. Set `GARMIN_DATA_DIR` to use another
  host directory.
- The app port is published on the VM's loopback only. Public traffic goes through Caddy.
- To bring existing training plans along, stop the app (`docker compose stop app`), copy your
  local `data/training.db` to `state/data/training.db`, then start it again.
- Women's-health tools are **off over HTTP** even if `I_AM_WOMAN=true`. They are special-category
  health data. Only set `MCP_HTTP_ALLOW_WOMEN_TOOLS=true` if you accept exposing them, and the
  server logs a warning when you do.

### Backups

The database runs in WAL mode, so don't copy the live file. Use SQLite's online backup, for
example from a daily cron job on the VM (`sudo apt install sqlite3`):

```bash
mkdir -p ~/backups
sqlite3 ~/GarminStravaMCP/state/data/training.db ".backup '$HOME/backups/training-$(date +%F).db'"
find ~/backups -name 'training-*.db' -mtime +14 -delete
```

Copy the backups off the VM regularly, for example with `scp` from your own machine. They contain
health and training data, so keep them private. Tokens don't need backups; just copy them across
again.

## 5. Auto-deploy on push (Phase 5)

`.github/workflows/ci-deploy.yml` builds and tests every push and pull request. On pushes to `main`
it then SSHes into the VM and runs `git pull && docker compose up -d --build`. The deploy step is
skipped until the secrets exist. To redeploy without pushing, run
`gh workflow run ci-deploy.yml --ref main` (or *Run workflow* in the Actions tab).

1. Create a dedicated key pair on your machine. Don't reuse your personal key:
   `ssh-keygen -t ed25519 -f ~/.ssh/garmin_deploy -C github-deploy -N ""`
2. On the VM, append the public key to `~/.ssh/authorized_keys`, pinned to the deploy command so a
   leaked key can only redeploy:

   ```text
   restrict,command="cd ~/GarminStravaMCP && git pull --ff-only && docker compose up -d --build --remove-orphans && docker image prune -f" ssh-ed25519 AAAA... github-deploy
   ```

3. Add these repository secrets (Settings → Secrets and variables → Actions). The repository is
   public, so never put these values in the workflow file:

   | Secret | Value |
   |---|---|
   | `DEPLOY_HOST` | VM public IP or DuckDNS hostname |
   | `DEPLOY_USER` | `ubuntu` |
   | `DEPLOY_SSH_KEY` | contents of `~/.ssh/garmin_deploy` (private key) |
   | `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 <exact DEPLOY_HOST value>`; host keys are matched by the name you connect to, so scanning the IP doesn't cover a hostname |
   | `DEPLOY_PATH` | optional, defaults to `GarminStravaMCP` (relative to the home directory) |

This needs port 22 reachable from GitHub's runners. If you later restrict SSH to your own IP, switch
to building an arm64 image in CI and pulling it on the VM.

## 6. Connecting clients (Phase 6)

The endpoint is `https://your-name.duckdns.org/mcp`, with the header
`Authorization: Bearer <MCP_AUTH_TOKEN>`. Never commit the token.

**VS Code / GitHub Copilot** (`.vscode/mcp.json` or the user `mcp.json`):

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

**Claude Code:**

```bash
claude mcp add --transport http garmin https://your-name.duckdns.org/mcp \
  --header "Authorization: Bearer $GARMIN_MCP_TOKEN"
```

**Claude Desktop** and other stdio-only clients, through the `mcp-remote` bridge:

```json
{
  "mcpServers": {
    "garmin": {
      "command": "npx",
      "args": ["mcp-remote", "https://your-name.duckdns.org/mcp", "--header", "Authorization:${GARMIN_MCP_AUTH}"],
      "env": { "GARMIN_MCP_AUTH": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

### Smoke tests

- `curl -s https://your-name.duckdns.org/healthz` returns `{"status":"ok"}`.
- `curl -s -o /dev/null -w '%{http_code}' -X POST https://your-name.duckdns.org/mcp` returns `401`.
- `garmin_get_activities` returns recent activities through the client.
- Create a training plan, run `docker compose restart`, and confirm the plan is still there.
- Watch `docker compose logs app` for Garmin 429s over the first few days.

## Security model

- Bearer token, at least 32 characters, compared in constant time. The server refuses to start in
  HTTP mode without one. After 10 failed attempts in 15 minutes a client gets `429`.
- `/healthz` needs no token and returns no data. Everything else except `/mcp` is a 404.
- Host and Origin headers must be localhost or `MCP_ALLOWED_HOSTS`, as DNS-rebinding protection.
- The server is stateless: each POST gets a fresh MCP server instance. GET and DELETE on `/mcp`
  return 405.
- Oracle can reclaim Always Free instances that stay idle for 7 days (CPU, network and memory
  under 20%). Upgrading the account to Pay As You Go keeps it free within the Always Free limits
  and avoids that.
