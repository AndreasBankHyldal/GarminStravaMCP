# Garmin Connect MCP Server

An MCP (Model Context Protocol) server for Garmin Connect activity analysis,
training plans, health metrics, and watch workout synchronization.

## Features

- Fetch, search, and inspect Garmin activities, laps, splits, heart rate, pace,
  cadence, elevation, and training effect.
- Analyze run pacing, interval structure, heart-rate drift, training trends,
  load/fatigue, readiness, and weekly progress.
- Read Garmin fitness stats, VO2max, training status, heart-rate zones, HRV,
  sleep, steps, workouts, and personal records.
- Create structured workouts and synchronize training plans to the Garmin
  calendar and compatible watches.
- Store training plans locally in SQLite.

## Setup

```bash
npm install
cp .env.example .env
npm run build
```

Set the Garmin Connect credentials in `.env`:

```dotenv
GARMIN_USERNAME=your.email@example.com
GARMIN_PASSWORD=your_password
```

If the account uses MFA, run the interactive authentication flow once:

```bash
npm run garmin-auth
```

Garmin uses an unofficial API through `@gooin/garmin-connect`. Cached session
tokens reduce repeated logins and MFA prompts.

### State directory

On Windows, state defaults to `%LOCALAPPDATA%\GarminMCP`. On macOS and Linux,
it defaults to the project root for backward compatibility. Override these
locations with `GARMIN_STATE_DIR` or `GARMIN_ENV_FILE`.

Existing Windows installations under `%LOCALAPPDATA%\GarminStravaMCP` are
detected automatically. The previous `GARMIN_STRAVA_STATE_DIR` and
`GARMIN_STRAVA_ENV_FILE` variable names remain accepted as migration aliases,
so existing Garmin tokens and training plans continue to work.

## MCP client configuration

Point the MCP client at the built entry point:

```json
{
  "mcpServers": {
    "garmin": {
      "command": "node",
      "args": ["/FULL/PATH/TO/REPOSITORY/dist/index.js"]
    }
  }
}
```

Credentials are read from the `.env` location described above and should not
be copied into the MCP client configuration.

## Available tools

### Garmin Connect

| Tool | Description |
|---|---|
| `garmin_get_activities` | Fetch recent activities |
| `garmin_get_activity_details` | Get activity details, laps, and interval structure |
| `garmin_get_personal_records` | Scan activities for personal records |
| `garmin_search_activities` | Search activities by distance, date, pace, or heart rate |
| `garmin_get_fitness_stats` | Get fitness profile and statistics |
| `garmin_get_training_status` | Get VO2max, training load, and recovery |
| `garmin_get_heart_rate` | Get daily heart-rate data |
| `garmin_get_heart_rate_zones` | Get configured heart-rate zones and thresholds |
| `garmin_get_hrv` | Get heart-rate variability data |
| `garmin_get_sleep` | Get sleep data and scores |
| `garmin_get_steps` | Get daily step count |
| `garmin_get_workouts` | Get Garmin workouts |
| `garmin_add_running_workout` | Create a structured running workout |
| `garmin_schedule_workout` | Schedule a workout |
| `garmin_delete_workout` | Delete a workout |

### Analysis and planning

| Tool | Description |
|---|---|
| `analyze_run_performance` | Analyze Garmin pacing, heart-rate drift, laps, and intervals |
| `get_training_trends` | Summarize weekly mileage, pace, and heart-rate trends |
| `race_day_strategy` | Build a VDOT-based race pacing and execution plan |
| `get_load_fatigue_model` | Compute CTL/ATL/TSB-style load and fatigue |
| `get_readiness_score` | Combine recovery metrics and training load |
| `weekly_coach_brief` | Generate a weekly training summary |
| `create_training_plan` | Create a local training plan with optional Garmin sync |
| `get_training_plan` | Read a training plan and its workouts |
| `update_training_plan` | Update a plan with optional Garmin delta-sync |
| `sync_training_plan_to_garmin` | Synchronize a plan to Garmin calendar |
| `adjust_training_plan` | Adapt upcoming workouts from compliance and load |
| `check_plan_compliance` | Compare planned workouts with Garmin activities |

## Development

```bash
npm run dev
npm run build
npm start
```

The server uses stdio transport. Runtime messages are sent to stderr so stdout
remains valid MCP protocol output.

## Archived Strava integration

The previous Strava implementation was removed from the active codebase because
registering an API application now requires a paid Strava subscription. It is
preserved exactly as it existed before removal on branch
`archive/strava-integration-2026-09-01` at commit
`2604fe939f3f683dad841a3e986c1dfafb158cd7`.

To create a working branch from the archive later:

```bash
git fetch origin
git switch -c reintroduce-strava origin/archive/strava-integration-2026-09-01
```

Review the then-current Strava API Agreement and API Brand Guidelines before
reintroducing it:

- <https://www.strava.com/legal/api>
- <https://www.strava.com/legal/api_policy>
- <https://developers.strava.com/docs/getting-started/>

## Security

Never commit credentials, OAuth tokens, Garmin session files, MFA codes, or live
SQLite databases. The repository ignore rules cover current Garmin state and
legacy archived token files.

## License

ISC
