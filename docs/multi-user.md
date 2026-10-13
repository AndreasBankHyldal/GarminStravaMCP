# Sharing the hosted server with other people

One hosted server can serve several people, each seeing **only their own** Garmin data and training
plans. The owner keeps using `MCP_AUTH_TOKEN` exactly as before. Everyone else gets a personal token
from the admin.

## How it works

```
Alice's PC ──(Alice's token)──▶ server ──(Alice's Garmin session)──▶ Garmin Connect
Bob's PC   ──(Bob's token)────▶ server ──(Bob's Garmin session)────▶ Garmin Connect
```

- **Per-user isolation.** The server resolves the token to a user for each request and uses that
  user's Garmin session and SQLite database. Nothing is shared between users except the server.
- **No Garmin passwords on the server.** Garmin blocks fresh logins from datacenter IPs anyway, so
  each person logs in on their **own** computer and uploads only the resulting session tokens.
  Their password never leaves their PC.
- **Only token hashes are stored.** `users.json` keeps a SHA-256 hash of each token. A lost token
  can't be recovered, only rotated.
- Women's-health tools stay off over HTTP for everyone unless `MCP_HTTP_ALLOW_WOMEN_TOOLS=true`.

State layout on the VM (`~/GarminStravaMCP/state`, mounted at `/data`):

```
state/
├── .garmin-tokens/          owner's Garmin session (unchanged)
├── data/training.db         owner's database (unchanged)
├── users.json               other users: id + token hash
└── users/<id>/
    ├── .garmin-tokens/      that user's uploaded Garmin session
    └── data/training.db     that user's training plans and logs
```

## Admin: managing users

Run these on the VM in `~/GarminStravaMCP`. Changes take effect immediately; no restart is needed.

```bash
docker compose exec app node dist/users/cli.js add alice      # prints Alice's token once
docker compose exec app node dist/users/cli.js list           # users and whether their Garmin session is uploaded
docker compose exec app node dist/users/cli.js rotate alice   # new token; the old one stops working
docker compose exec app node dist/users/cli.js remove alice   # revoke access, keep data
docker compose exec app node dist/users/cli.js remove alice --purge   # revoke and delete their data
```

User ids are 1–32 lowercase letters, digits, `-` or `_`, and `owner` is reserved. Send the token
privately, for example as a password-manager share, never in a public channel. Only add people who
have agreed to their health and training data being stored on your server.

## New user: getting started

You need the server URL (for example `https://your-name.duckdns.org`) and your personal token from
the admin.

### 1. Upload your Garmin session (once, and again when it expires)

This is the only step that needs your Garmin password, and it runs on **your** computer. Install
[Node.js](https://nodejs.org) 22 or newer and [git](https://git-scm.com), then:

```bash
git clone https://github.com/AndreasBankHyldal/GarminStravaMCP.git
cd GarminStravaMCP
npm ci
```

Create a `.env` file in that folder:

```dotenv
GARMIN_USERNAME=you@example.com
GARMIN_PASSWORD=your-garmin-password
```

Log in and upload. Enter the MFA code if Garmin asks for one, and paste your personal token when
prompted:

```bash
npm run garmin-auth -- --upload https://your-name.duckdns.org
```

You should see `✅ Garmin session uploaded … for user "<your id>"`. Afterwards you can delete
`GARMIN_PASSWORD` from `.env`; the server never needs it. To skip the prompt, set the token in the
environment first: `export GARMIN_MCP_TOKEN=...` (macOS/Linux) or `$env:GARMIN_MCP_TOKEN="..."`
(PowerShell).

If the upload fails after a successful login, retry it without logging in again by adding
`--skip-login`.

### 2. Connect your AI client

Follow [connect-clients.md](connect-clients.md) with **your personal token** as `<TOKEN>`. Then ask:
*"Show my last 2 Garmin activities."* You should see your own activities.

### When your Garmin session expires

Garmin sessions last about a year. When tools start failing with *"No valid Garmin session"*, rerun
step 1. There's no need to change your client configuration.

## Limits

- Everyone shares one server IP towards Garmin. Requests are queued with a small gap between them
  to stay under Garmin's rate limits, so heavy use by several people at once is slower.
- Each additional account increases the chance of Garmin rate limiting or bot challenges from the
  datacenter IP. Watch `docker compose logs app` for 429s after adding people.
- Back up every user's database, not just the owner's (see
  [hosting-oracle.md](hosting-oracle.md#backups)).
