# Get started: your Garmin data in your AI assistant

This guide connects **your own** Garmin Connect account to an AI assistant (Claude Desktop, Claude
Code or VS Code) through a shared Garmin MCP server. Afterwards you can ask things like *"How did my
long run on Sunday go?"* or *"Am I ready for a hard workout today?"*.

⏱️ About 10 minutes. You do it once; the Garmin connection lasts about a year.

## ✅ Before you start

You need:

| | What | Where to get it |
|---|---|---|
| 1 | **Server address**, like `https://something.duckdns.org` | From the person running the server |
| 2 | **Your personal access token**, a long code | From the person running the server, sent privately |
| 3 | Your **Garmin Connect** email and password | You already have these |
| 4 | A Mac or Windows PC | |

> 🔒 Your token works like a password: it gives access to **your** Garmin data. Don't share it, and
> don't paste it into an AI chat. You only ever type it into your own terminal or settings.

---

## Step 1: Install Node.js

Node.js runs the small helper programs used below.

1. Go to <https://nodejs.org> and download the **LTS** version.
2. Run the installer and accept the defaults.
3. Check that it worked by opening a terminal:
   - **Mac:** press `Cmd + Space`, type **Terminal**, press Enter.
   - **Windows:** press the Windows key, type **Terminal** (or **PowerShell**), press Enter.

   Then type this and press Enter:

   ```bash
   node -v
   ```

   You should see a version like `v24.x.x`. If you see "command not found", restart the computer
   and try again.

Keep the terminal open for the next step.

---

## Step 2: Connect your Garmin account (one time)

This step logs in to Garmin **on your own computer** and sends only a login *session* to the
server. **Your Garmin password never leaves your computer.**

### 2a. Download the helper

Pick **one** option.

**Option A, with Git** (if `git --version` works in your terminal):

```bash
git clone https://github.com/AndreasBankHyldal/GarminStravaMCP.git
cd GarminStravaMCP
```

**Option B, without Git:**

1. Open <https://github.com/AndreasBankHyldal/GarminStravaMCP>.
2. Click the green **Code** button, then **Download ZIP**.
3. Unzip it, for example into your **Downloads** folder.
4. In the terminal, go into the folder:
   - **Mac:** `cd ~/Downloads/GarminStravaMCP-main`
   - **Windows:** `cd $HOME\Downloads\GarminStravaMCP-main`

### 2b. Install the helper

```bash
npm ci
```

This takes a minute. Warnings in yellow are normal.

### 2c. Log in and upload

Replace the address with the server address you were given:

```bash
npm run garmin-auth -- --upload https://something.duckdns.org
```

You'll be asked, in this order:

1. **Garmin Connect email:** type it and press Enter.
2. **Garmin Connect password (hidden):** type it and press Enter. Nothing appears while you type;
   that's on purpose.
3. **Verification code:** only if Garmin sends you one by email or SMS. Type it, or just press
   Enter if you didn't get one.
4. **Paste your personal access token (hidden):** paste the token and press Enter.

You're done with this step when you see:

```
✅ Garmin session uploaded to something.duckdns.org for user "yourname".
```

You won't need this folder again until your Garmin connection expires, in about a year.

---

## Step 3: Add the server to your AI app

Pick the app you use. In every example, replace:
- `https://something.duckdns.org` with **your server address**
- `YOUR_TOKEN` with **your personal access token**

### Option A: Claude Desktop

1. Open Claude Desktop and go to **Settings → Developer → Edit Config**. This shows a file called
   `claude_desktop_config.json` (sometimes it opens the folder that contains it).
2. Open that file in a plain text editor: right-click → **Open With → TextEdit** on Mac, or
   **Notepad** on Windows.
3. **If the file is empty or only contains `{}`**, replace everything with:

   ```json
   {
     "mcpServers": {
       "garmin": {
         "command": "npx",
         "args": ["-y", "mcp-remote", "https://something.duckdns.org/mcp", "--header", "Authorization:${GARMIN_MCP_AUTH}"],
         "env": { "GARMIN_MCP_AUTH": "Bearer YOUR_TOKEN" }
       }
     }
   }
   ```

   **If the file already has an `"mcpServers"` section**, add only the `"garmin": { … }` block
   inside it, with a comma between it and the entry before it.
4. Check two details:
   - The address ends in **`/mcp`**.
   - There's exactly **one space** in `"Bearer YOUR_TOKEN"` and **no space** in
     `Authorization:${GARMIN_MCP_AUTH}`.
5. Save the file.
6. **Quit Claude Desktop completely** (Mac: `Cmd + Q`; Windows: right-click the Claude icon by the
   clock and choose **Quit**), then open it again.
7. Click the **tools / connectors** icon in the chat box. You should see **garmin** with a list of
   tools.

### Option B: Claude Code

Run this in your terminal (one command):

```bash
claude mcp add --transport http --scope user garmin https://something.duckdns.org/mcp --header "Authorization: Bearer YOUR_TOKEN"
```

Then start Claude Code and type `/mcp`. **garmin** should show as connected.

### Option C: VS Code (GitHub Copilot Chat)

1. Press `Cmd + Shift + P` (Mac) or `Ctrl + Shift + P` (Windows) and run
   **MCP: Open User Configuration**.
2. Replace the content with the following. If the file already has servers, add only the
   `"garmin"` block and the `"inputs"` entry.

   ```json
   {
     "inputs": [
       { "type": "promptString", "id": "garmin-mcp-token", "description": "Garmin MCP token", "password": true }
     ],
     "servers": {
       "garmin": {
         "type": "http",
         "url": "https://something.duckdns.org/mcp",
         "headers": { "Authorization": "Bearer ${input:garmin-mcp-token}" }
       }
     }
   }
   ```

3. Save. VS Code asks for the token the first time; paste it there. It's stored securely.

Using another app? See [connect-clients.md](connect-clients.md).

---

## Step 4: Try it 🎉

Ask your assistant:

- *"Show my last 3 Garmin activities."*
- *"Analyze my most recent run."*
- *"What's my training readiness today?"*
- *"Make me a 6-week plan for a 10K."*

You should see **your own** activities.

---

## Something not working?

| What you see | What to do |
|---|---|
| `node: command not found` / `npm` not recognized | Restart the computer after installing Node.js, then open a new terminal. |
| `npm ci` fails | Make sure you're inside the `GarminStravaMCP` folder (`cd` into it) and try again. |
| *"The server rejected the access token (401)"* during upload | The token was mistyped or incomplete. Paste it again, or ask for a new one. |
| *"Garmin login failed"* | Check your Garmin email and password at <https://connect.garmin.com>, wait a minute, then try again. Don't retry many times in a row, or Garmin may temporarily block you. |
| Upload failed but the login worked | Run the same command again with ` --skip-login` added at the end. |
| Claude Desktop shows no **garmin** tools | Usually a typo in the config file, such as a missing comma or quote. Paste the file into <https://jsonlint.com> to check it, and quit Claude completely before reopening. |
| *"No valid Garmin session for user …"* | Step 2 wasn't completed, or your Garmin connection expired. Do Step 2c again. |
| *"Too many failed authentication attempts"* | Wait 15 minutes, then fix the token in your app settings. |

Still stuck? Send the person running the server the exact error message, but **not** your token or
password.

---

## FAQ

**Is my Garmin password stored anywhere?**
No. It's only used on your computer in Step 2. The server receives a login session, never the
password.

**Who can see my data?**
Other users can't. Each token only sees its own Garmin account and training plans. The person
running the server manages the machine it runs on, so only connect if you trust them with your
training data.

**What happens in a year?**
Garmin sessions expire. When the assistant says *"No valid Garmin session"*, repeat **Step 2c**.
Your app settings don't change.

**How do I stop using it?**
Remove the `garmin` entry from your app's settings and ask the server owner to remove your account
(they can delete your data too). You can delete the downloaded folder.
