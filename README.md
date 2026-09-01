# MCP Strava & Garmin Connect Server

An MCP (Model Context Protocol) server that integrates with **Strava** and **Garmin Connect**, letting AI assistants (Claude Desktop, VS Code Copilot) fetch activities, analyze run performance, plan training, and track fitness stats, all through natural conversation.

## Features

### 🏃 Strava Integration
- Fetch recent activities with date filters
- Detailed activity data (laps, splits, heart rate, pace)
- Time-series data streams (HR, pace, elevation, cadence)
- Athlete aggregate stats (totals, year-to-date, all-time)
- Create manual activities and update existing ones

### ⌚ Garmin Connect Integration
- Fetch and search activities with flexible filters
- Personal records scanner (fastest pace, highest HR, longest run, etc.)
- Fitness stats, VO2max, and training status
- Heart rate, configured sport-specific HR zones, HRV, sleep, and step data
- **Structured workouts** with step-by-step guidance on your watch (warmup → intervals → recovery → cooldown)
- Schedule workouts on your Garmin calendar (syncs to watch)
- Training status and recovery insights

### 📊 Analysis
- Run performance analysis (pace consistency, HR drift, split analysis, effort classification)
- **Interval-aware lap analysis** — surfaces each watch lap (e.g. 600m reps) at its true pace instead of averaging it into 1km splits, auto-detects interval workouts, and generates a quick summary like `6×600m @ 3:45/km` (works for any rep distance: 400m, 800m, 1km, mile, mixed/pyramid sessions)
- Training trends over weeks/months (weekly mileage, pace trends)
- Compare Strava vs Garmin data for the same activity
- **Best efforts calculator** — rolling 1K/5K/10K/HM PRs from Strava splits/streams
- **Load & fatigue model** — CTL/ATL/TSB-style model with acute:chronic ratio risk flags
- **Readiness score** — combines sleep, HRV, resting HR, and training load into clear daily guidance
- **Weekly coach brief** — automated performance summary + actionable recommendations
- **Race day strategy** — VDOT-based pacing plan with km-by-km splits, HR targets, weather/elevation/wind adjustments, fueling/hydration plan, and course tactics
- Pre-computed effort levels and HR zone classification on all activities

### Women's Training & Menstrual Health
- Symptom-led training context using local logs plus Garmin sleep/need, HRV, resting HR, Body Battery change, load/recovery, hydration, weight, VO2max, respiration, Pulse Ox, and skin temperature when available
- Probabilistic cycle context that explicitly avoids universal phase-based training rules
- Personal pattern comparison across completed cycles
- Workload-based carbohydrate, protein, recovery, and hydration targets
- Non-diagnostic energy-availability, RED-S, iron, bleeding, pregnancy, and bone-health guardrails
- Sensitive Garmin menstrual/pregnancy reads behind a separate, disabled-by-default opt-in

See [Women's Training and Menstrual-Health Tools](docs/womens-training.md)
for the research basis, limitations, privacy model, and references.

### 📋 Training Plans
- Create multi-week training plans stored locally (SQLite)
- **Smart Garmin sync (delta sync)** — create/update/reschedule/remove workouts without duplicates
- **Sync to Garmin calendar** — workouts appear on the correct dates and sync to your watch
- **Structured workouts** — intervals, tempo, long runs all get proper step-by-step structure (not just a single distance)
- **Adaptive plan engine** — automatically adjust upcoming workouts based on compliance and current fatigue/load
- Track planned workouts (easy run, tempo, intervals, long run, rest)
- Check plan compliance against actual activities

#### Structured Workout Steps

When synced to Garmin, each workout type gets appropriate step structure on your watch:

| Workout Type | Garmin Steps |
|---|---|
| **Intervals** | Warmup → N×(fast interval + jog recovery) → Cooldown |
| **Tempo** | Warmup → Tempo block at target pace → Cooldown |
| **Long Run** | Easy start → Steady main block → Easy finish |
| **Easy/Recovery** | Warmup → Easy main → Cooldown |
| **Race** | Warmup → Race pace → Cooldown |

Your watch beeps at each transition and shows target pace where applicable.

### 🧠 Smart Formatting
All activity data includes enriched context to help AI assistants reason accurately:
- **Temporal context**: day-of-week, human-readable dates, "days ago" counts
- **Effort classification**: easy / moderate / tempo / threshold / interval
- **HR zone labels**: Zone 1–5 with descriptions
- **Pre-computed metrics**: pace per km, formatted durations, elevation data

### 📚 MCP Resources
Always-available context that AI assistants can reference without tool calls:

| Resource | URI | Description |
|----------|-----|-------------|
| Athlete Profile | `strava://athlete/profile` | Strava totals (recent, YTD, all-time), HR zone reference, unit preferences |
| Garmin Health | `garmin://health/today` | Today's heart rate, sleep, and step data from Garmin |

### 💬 MCP Prompts
Pre-built multi-step analysis workflows — use these as conversation starters:

| Prompt | Description |
|--------|-------------|
| `analyze-recent-training` | Comprehensive multi-week training analysis with trends and recommendations |
| `activity-deep-dive` | Deep dive into a specific activity: splits, HR analysis, pacing strategy |
| `training-readiness-check` | Today's readiness check based on recent load, sleep, and recovery |
| `compare-recent-runs` | Side-by-side comparison of recent runs to spot trends |
| `race-plan` | Generate a structured training plan for an upcoming race |

## Setup

### 1. Clone and install

```bash
cd mcpStravaGarmin
npm install
npm run build
```

### 2. Configure credentials

Credentials and generated state are stored outside the repository on Windows so
OneDrive does not sync live SQLite files or authentication tokens.

**Windows (PowerShell):**

```powershell
$stateDir = Join-Path $env:LOCALAPPDATA "GarminStravaMCP"
New-Item -ItemType Directory -Force $stateDir | Out-Null
$envFile = Join-Path $stateDir ".env"
if (-not (Test-Path $envFile)) {
  Copy-Item .env.example $envFile
}
notepad $envFile
```

**macOS/Linux:**

```bash
cp .env.example .env
```

On Windows the default state directory is
`%LOCALAPPDATA%\GarminStravaMCP`; on macOS/Linux it remains the project root.
Set `GARMIN_STRAVA_STATE_DIR` before launching the process to override the state
directory, or `GARMIN_STRAVA_ENV_FILE` to use an explicit credential file.
Relative `DB_PATH` values resolve from the state directory.
Existing project-local Windows tokens or databases remain usable with a startup
warning so upgrades do not appear to lose authentication or training plans.

#### Strava Setup
1. Go to [Strava API Settings](https://www.strava.com/settings/api) and create an application
2. Set the **Authorization Callback Domain** to `localhost`
3. Copy your **Client ID** and **Client Secret** into `.env`
4. Run the one-time OAuth flow:

```bash
npm run strava-auth
```

Open the displayed authorization URL in your browser. The flow saves tokens in
the state directory, and they auto-refresh on subsequent use.

#### Garmin Connect Setup
Add your Garmin Connect credentials to `.env`:

```
GARMIN_USERNAME=your.email@example.com
GARMIN_PASSWORD=your_password
```

All women-specific tools, prompts, and server guidance are disabled by default,
so the standard MCP experience is unchanged. Enable them with:

```env
I_AM_WOMAN=true
```

Garmin reproductive-health reads require a second opt-in because they use
undocumented consumer endpoints. After reviewing the privacy and API limitations
in [the women's training documentation](docs/womens-training.md), enable both:

```env
I_AM_WOMAN=true
GARMIN_WOMENS_HEALTH_ENABLED=true
```

Restart the MCP server after changing either setting.

If your Garmin account has **MFA / two-factor authentication** enabled (Garmin sends a code via SMS/email/app), run the one-time interactive login so you can enter that code:

```bash
npm run garmin-auth
```

This logs in, prompts you for the MFA code, and caches your session in the state
directory. The MCP server reuses those tokens and only needs a fresh login when
they expire (avoiding repeated MFA prompts). The server itself runs over stdio
and **cannot** prompt for an MFA code — so if you see an MFA error from the
server, run `npm run garmin-auth` and restart it.

> ⚠️ Garmin uses an unofficial API (`@gooin/garmin-connect`). Session tokens
> are cached to minimize logins and avoid triggering MFA on every start.

### 3. Configure your MCP client

#### Claude Desktop on Windows

Open **Settings → Developer → Edit Config**, or edit
`%APPDATA%\Claude\claude_desktop_config.json`. Use absolute paths and escape
backslashes in JSON:

```json
{
  "mcpServers": {
    "strava-garmin": {
      "command": "C:\\FULL\\PATH\\TO\\node.exe",
      "args": ["C:\\FULL\\PATH\\TO\\GarminStravaMCP\\dist\\index.js"]
    }
  }
}
```

Completely quit and reopen Claude Desktop after saving the configuration. MCP
logs are available under `%APPDATA%\Claude\logs` if the server does not appear.

#### Claude Desktop on macOS

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "strava-garmin": {
      "command": "node",
      "args": ["/FULL/PATH/TO/mcpStravaGarmin/dist/index.js"]
    }
  }
}
```

Credentials are read from the platform-specific `.env` location described
above — do not duplicate them in the Claude configuration.

#### VS Code (Copilot)

Add to your `.vscode/mcp.json`:

```json
{
  "mcpServers": {
    "strava-garmin": {
      "command": "node",
      "args": ["${workspaceFolder}/dist/index.js"]
    }
  }
}
```

## Available Tools

### Strava

| Tool | Description |
|------|-------------|
| `strava_get_activities` | Fetch recent Strava activities with optional date filters |
| `strava_get_activity_details` | Get detailed data for a Strava activity (interval-aware laps with rep summary, 1km splits) |
| `strava_get_athlete_stats` | Get aggregate athlete stats (totals, year-to-date) |
| `strava_get_activity_streams` | Get time-series data (HR, pace, elevation, cadence) |
| `strava_create_activity` | Create a manual activity on Strava |
| `strava_update_activity` | Update an existing Strava activity |

### Garmin Connect

| Tool | Description |
|------|-------------|
| `garmin_get_activities` | Fetch recent Garmin activities |
| `garmin_get_activity_details` | Get detailed Garmin activity data with laps and interval/recovery structure |
| `garmin_get_personal_records` | Scan up to 500 activities for all-time bests |
| `garmin_search_activities` | Search activities with flexible filters (distance, HR, date, pace) |
| `garmin_get_fitness_stats` | Get fitness profile and stats |
| `garmin_get_training_status` | Get VO2max, training load, recovery time |
| `garmin_get_heart_rate` | Get heart rate data for a specific date |
| `garmin_get_heart_rate_zones` | Get configured sport-specific BPM zones, max HR, resting HR, and lactate-threshold HR |
| `garmin_get_hrv` | Get Heart Rate Variability data |
| `garmin_get_sleep` | Get sleep data and quality scores |
| `garmin_get_steps` | Get daily step count |
| `garmin_get_workouts` | Get planned workouts from Garmin |
| `garmin_add_running_workout` | Create a structured running workout with steps (warmup, intervals, recovery, cooldown) — syncs to watch |
| `garmin_schedule_workout` | Schedule a workout for a specific date |
| `garmin_delete_workout` | Delete a workout from Garmin |

### Analysis

| Tool | Description |
|------|-------------|
| `analyze_run_performance` | Deep analysis from Strava or Garmin: pace consistency, HR drift, splits/laps, and interval breakdown |
| `compare_activities` | Compare Strava vs Garmin data for the same activity |
| `get_training_trends` | Weekly mileage, pace, and HR trends |
| `race_day_strategy` | VDOT-based race pacing plan with km-by-km splits, HR targets, weather/elevation/wind adjustments, and execution pack (fueling/hydration/course tactics) |
| `get_best_efforts` | Compute rolling best efforts (1K/5K/10K/HM) from Strava splits/streams |
| `get_load_fatigue_model` | CTL/ATL/TSB-style load model with acute:chronic ratio and fatigue risk |
| `get_readiness_score` | Daily readiness score from sleep, HRV, resting HR, and load balance |
| `weekly_coach_brief` | Weekly summary with trend deltas, adherence snapshot, and coaching notes |

### Women's Training & Menstrual Health

This entire tool group is registered only when `I_AM_WOMAN=true`.

| Tool | Description |
|------|-------------|
| `women_set_health_profile` | Store life stage, contraception context, and usual cycle details locally |
| `women_log_daily_health` | Log period events, symptoms, subjective recovery, and session response |
| `women_delete_cycle_event` | Correct a locally recorded cycle event |
| `women_get_cycle_context` | Probabilistic calendar context with explicit uncertainty and no phase-only training rule |
| `garmin_get_recovery_snapshot` | Garmin sleep/need, HRV, HR, Body Battery change, load/recovery, hydration, weight, VO2max, respiration, Pulse Ox, and skin temperature |
| `garmin_get_extended_wellness` | Raw Body Battery and all-day stress data with unavailable fields reported |
| `women_get_training_context` | Symptom-led training estimate combining local logs and Garmin recovery |
| `women_get_nutrition_targets` | Evidence-based fueling/hydration ranges based on workload and session duration |
| `women_estimate_energy_availability` | Uncertainty-aware educational EA estimate; not a RED-S diagnosis |
| `women_screen_training_health` | Educational triage for menstrual, iron, bone, pregnancy, and under-fueling concerns |
| `women_analyze_cycle_training_patterns` | Descriptive within-athlete comparisons across completed cycles |

With both `I_AM_WOMAN=true` and `GARMIN_WOMENS_HEALTH_ENABLED=true`, the server also registers
`garmin_get_menstrual_day`, `garmin_get_menstrual_calendar`, and
`garmin_get_pregnancy_summary`. Garmin does not publish the private response
schema, so these tools return opaque JSON and unverified date candidates rather
than inventing period-start fields.

### Training Plans

| Tool | Description |
|------|-------------|
| `create_training_plan` | Create a multi-week training plan (optionally sync structured workouts to Garmin calendar) |
| `get_training_plan` | View a training plan and its workouts |
| `update_training_plan` | Modify a training plan/workouts (optionally smart-sync updates to Garmin) |
| `sync_training_plan_to_garmin` | Smart delta-sync a plan to Garmin calendar (create/update/reschedule/remove) |
| `adjust_training_plan` | Adaptive plan optimization based on compliance + current load/fatigue |
| `check_plan_compliance` | Check adherence to training plan vs actual activities |

## Example Prompts

Once connected, try asking your AI assistant:

- *"Show me my last 10 runs from Strava"*
- *"Analyze my most recent run — how consistent was my pacing?"*
- *"What were my rep paces in yesterday's interval session?"*
- *"What's my weekly mileage trend over the last 8 weeks?"*
- *"Compare my last run between Strava and Garmin"*
- *"What's my fastest 5K ever?"*
- *"Show me all runs over 15km this year"*
- *"Find my fastest 5K and fastest 10K from all recent runs"*
- *"Give me my training load model (CTL/ATL/TSB) for the last 90 days"*
- *"What is my readiness score today and should I do hard intervals?"*
- *"Give me a weekly coach brief for last week"*
- *"Create a 4-week half marathon training plan starting next Monday"*
- *"Make me an interval workout plan and sync it to my Garmin"*
- *"Create a race day strategy for a 10K in 50 minutes with 60m elevation, 18°C and 20 km/h wind"*
- *"Adjust my plan based on the last 2 weeks and apply the changes"*
- *"Am I ready for a hard workout today?"*
- *"How well am I following my training plan?"*
- *"What was my sleep quality last night?"*
- *"Show me my configured Garmin heart rate zones"*
- *"Create a tempo run workout on Garmin for tomorrow"*

## Architecture

```
src/
├── index.ts              # Entry point, MCP server setup, resources, prompts
├── config.ts             # State paths and manual .env parser (avoids stdout issues)
├── utils.ts              # Shared formatting: enrichDate, pace, duration, zones, interval/lap analysis
├── strava/
│   ├── auth.ts           # OAuth token management with auto-refresh
│   ├── auth-flow.ts      # One-time browser OAuth flow (npm run strava-auth)
│   ├── client.ts         # Strava API client
│   └── tools.ts          # Strava MCP tool definitions
├── garmin/
│   ├── client.ts         # Garmin Connect API wrapper (@gooin/garmin-connect)
│   ├── auth-flow.ts      # One-time interactive login with MFA support (npm run garmin-auth)
│   └── tools.ts          # Garmin MCP tool definitions
├── analysis/
│   └── tools.ts          # Run analysis and comparison tools
├── planning/
│   └── tools.ts          # Training plan CRUD tools
└── db/
    └── database.ts       # SQLite setup and migrations
```

## Development

```bash
# Run with tsx (hot reload)
npm run dev

# Build TypeScript
npm run build

# Run built version
npm start

# Re-authenticate Strava
npm run strava-auth

# Re-authenticate Garmin (interactive, handles MFA/SMS code)
npm run garmin-auth
```

## Technical Notes

- **MCP transport**: stdio (newline-delimited JSON). All non-MCP stdout is redirected to stderr to prevent protocol corruption.
- **State directory**: On Windows, credentials, tokens, MFA files, and SQLite
  data default to `%LOCALAPPDATA%\GarminStravaMCP` so they stay outside
  OneDrive-synced source trees. macOS/Linux retain project-local state for
  backward compatibility.
- **Strava OAuth**: Tokens are stored in the state directory and auto-refreshed.
  The `.env` file holds initial/fallback tokens only.
- **Garmin auth**: Token-first authentication with auto-retry on 403 and a
  60-second login cooldown to avoid rate limiting (429). Tokens are cached in
  the state directory.
- **Garmin reliability layer**: request queueing + request spacing, 429 backoff with retries, periodic token health checks, and re-auth retry on session expiry.
- **Structured workouts**: Built using Garmin's `workoutSegments` API with `ExecutableStepDTO` and `RepeatGroupDTO` step types. Supports warmup, interval, recovery, rest, cooldown, and repeat groups with pace targets.
- **Smart Garmin plan sync**: state tracked in `garmin_workout_sync` table so updates become delta operations (no duplicate workout spam).
- **VDOT calculations**: Race day strategy uses the Daniels & Gilbert formula to estimate VO2max from recent efforts and predict equivalent race times.
- **Best efforts**: rolling-distance PRs use split windows first, then stream-based interpolation fallback for accuracy.
- **Interval/lap analysis**: reads the watch's recorded laps (not just Strava's 1km auto-splits), which is where the true rep structure lives. A workout is flagged as intervals when lap pace varies meaningfully and several laps aren't ~1km; work reps (faster than the run's average lap pace) are bucketed to the nearest 100m to absorb GPS noise and summarized as e.g. `6×600m @ 3:45/km`. Requires the run to actually contain laps (lap-button presses, auto-lap, or structured workouts) — runs with only 1km auto-laps have nothing finer to show.
- **Readiness model**: combines Garmin recovery metrics with load balance (TSB + acute:chronic ratio) for daily training guidance.
- **Women's training model**: current symptoms and personal recovery trends take priority over estimated menstrual phase. Calendar estimates never reach high confidence and never change training by themselves.
- **Reproductive-health privacy**: local cycle logs remain in SQLite. Optional Garmin menstrual/pregnancy reads are separately gated, read-only, and never auto-import undocumented response fields.
- **DB path**: Resolves to an absolute state-directory path so it works when
  launched from Claude Desktop (which has a different CWD than the project
  root).

## Rate Limits

- **Strava**: 100 requests per 15 minutes, 1,000 per day
- **Garmin**: Unofficial API — be conservative with request frequency

## Strava API 2026 Compliance Notes

Strava announced developer program changes in 2026 (ahead of its IPO). Status for this server, as of June 2026:

- **Endpoints used are unaffected.** This server only calls core athlete/activity/streams endpoints (`/athlete`, `/athlete/activities`, `/activities/{id}`, `/activities/{id}/streams`, `/athletes/{id}/stats`). The retiring endpoints (e.g. club details) are **not used here**, so no code migration is required.
- **Auth model is already compliant.** Fully OAuth-authenticated with scopes `read, activity:read_all, profile:read_all`; only the authenticated user's own data is ever fetched (satisfies the "own-data-only" display rule and the move to authenticated-only access).
- **⚠️ Developer fee (~$11.99/month).** May apply to API access generally. If unpaid and enforced on your client ID, token refresh in [src/strava/auth.ts](src/strava/auth.ts) will start failing. Verify on the [Strava developer dashboard](https://www.strava.com/settings/api).
- **⚠️ New developer program review.** Existing apps must resubmit an application for review (6-month window). This is a dashboard action, not a code change.
- **⚠️ AI-use clause (2024).** The agreement restricts using API data "in AI models or similar applications" — primarily aimed at *training* models. This server only feeds your own data to an assistant for personal analysis, but the wording is broad; be aware of it.
- **ℹ️ Official Strava MCP connector (planned).** Strava intends to ship a native MCP. No timeline given; no action needed, but it may eventually overlap with this server.

> Verify specifics for your app at [developers.strava.com](https://developers.strava.com/) or `developers@strava.com` before paying or resubmitting — the public announcements are vague on exact endpoint names and dates.

## Security

On Windows, keep the default state directory under `%LOCALAPPDATA%` so
credentials, OAuth/session tokens, and the live SQLite WAL database are neither
committed nor synchronized by OneDrive. The `.gitignore` also excludes legacy
project-local credentials, token files, SQLite databases, and WAL/SHM sidecars
as defense in depth.

Never commit or paste credentials, OAuth tokens, session files, or MFA codes.

## License

ISC
