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
- Heart rate, HRV, sleep, and step data
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

Copy the example env file and fill in your credentials:

```bash
cp .env.example .env
```

#### Strava Setup
1. Go to [Strava API Settings](https://www.strava.com/settings/api) and create an application
2. Set the **Authorization Callback Domain** to `localhost`
3. Copy your **Client ID** and **Client Secret** into `.env`
4. Run the one-time OAuth flow:

```bash
npm run strava-auth
```

This opens a browser for authorization and saves your tokens to `.strava-tokens.json`. Tokens auto-refresh on subsequent use.

#### Garmin Connect Setup
Add your Garmin Connect credentials to `.env`:

```
GARMIN_USERNAME=your.email@example.com
GARMIN_PASSWORD=your_password
```

If your Garmin account has **MFA / two-factor authentication** enabled (Garmin sends a code via SMS/email/app), run the one-time interactive login so you can enter that code:

```bash
npm run garmin-auth
```

This logs in, prompts you for the MFA code, and caches your session to `.garmin-tokens/`. The MCP server reuses those tokens and only needs a fresh login when they expire (avoiding repeated MFA prompts). The server itself runs over stdio and **cannot** prompt for an MFA code — so if you see an MFA error from the server, run `npm run garmin-auth` and restart it.

> ⚠️ Garmin uses an unofficial API (`@gooin/garmin-connect`). Session tokens are cached in `.garmin-tokens/` to minimize logins and avoid triggering MFA on every start.

### 3. Configure your MCP client

#### Claude Desktop

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

Credentials are read from the `.env` file in the project directory — no need to duplicate them in the config.

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
| `garmin_get_activity_details` | Get detailed Garmin activity data |
| `garmin_get_personal_records` | Scan up to 500 activities for all-time bests |
| `garmin_search_activities` | Search activities with flexible filters (distance, HR, date, pace) |
| `garmin_get_fitness_stats` | Get fitness profile and stats |
| `garmin_get_training_status` | Get VO2max, training load, recovery time |
| `garmin_get_heart_rate` | Get heart rate data for a specific date |
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
| `analyze_run_performance` | Deep analysis of a run: pace consistency, HR drift, 1km splits, and per-lap interval breakdown (true rep pace + auto interval summary) |
| `compare_activities` | Compare Strava vs Garmin data for the same activity |
| `get_training_trends` | Weekly mileage, pace, and HR trends |
| `race_day_strategy` | VDOT-based race pacing plan with km-by-km splits, HR targets, weather/elevation/wind adjustments, and execution pack (fueling/hydration/course tactics) |
| `get_best_efforts` | Compute rolling best efforts (1K/5K/10K/HM) from Strava splits/streams |
| `get_load_fatigue_model` | CTL/ATL/TSB-style load model with acute:chronic ratio and fatigue risk |
| `get_readiness_score` | Daily readiness score from sleep, HRV, resting HR, and load balance |
| `weekly_coach_brief` | Weekly summary with trend deltas, adherence snapshot, and coaching notes |

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
- *"Create a tempo run workout on Garmin for tomorrow"*

## Architecture

```
src/
├── index.ts              # Entry point, MCP server setup, resources, prompts
├── config.ts             # Manual .env parser (avoids dotenv stdout issues)
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
- **Strava OAuth**: Tokens saved to `.strava-tokens.json` and auto-refreshed. The `.env` file holds initial/fallback tokens only.
- **Garmin auth**: Token-first authentication with auto-retry on 403 and a 60-second login cooldown to avoid rate limiting (429). Tokens cached in `.garmin-tokens/`.
- **Garmin reliability layer**: request queueing + request spacing, 429 backoff with retries, periodic token health checks, and re-auth retry on session expiry.
- **Structured workouts**: Built using Garmin's `workoutSegments` API with `ExecutableStepDTO` and `RepeatGroupDTO` step types. Supports warmup, interval, recovery, rest, cooldown, and repeat groups with pace targets.
- **Smart Garmin plan sync**: state tracked in `garmin_workout_sync` table so updates become delta operations (no duplicate workout spam).
- **VDOT calculations**: Race day strategy uses the Daniels & Gilbert formula to estimate VO2max from recent efforts and predict equivalent race times.
- **Best efforts**: rolling-distance PRs use split windows first, then stream-based interpolation fallback for accuracy.
- **Interval/lap analysis**: reads the watch's recorded laps (not just Strava's 1km auto-splits), which is where the true rep structure lives. A workout is flagged as intervals when lap pace varies meaningfully and several laps aren't ~1km; work reps (faster than the run's average lap pace) are bucketed to the nearest 100m to absorb GPS noise and summarized as e.g. `6×600m @ 3:45/km`. Requires the run to actually contain laps (lap-button presses, auto-lap, or structured workouts) — runs with only 1km auto-laps have nothing finer to show.
- **Readiness model**: combines Garmin recovery metrics with load balance (TSB + acute:chronic ratio) for daily training guidance.
- **DB path**: Uses absolute paths to work correctly when launched from Claude Desktop (which has a different CWD than the project root).

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

The `.gitignore` excludes sensitive files:
- `.env` — API credentials
- `.strava-tokens.json` — OAuth access/refresh tokens
- `.garmin-tokens/` — Garmin session tokens
- `data/` — Local SQLite database

Never commit these files to version control.

## License

ISC
