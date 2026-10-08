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
- Interactive MCP Apps dashboards for run analysis, trends, heart-rate zones,
  load/fatigue, readiness, weekly coaching, and race pacing.

### Interactive fitness dashboards

The following tools have interactive dashboards. **GitHub Copilot desktop uses
the native canvas extension described below**; other MCP Apps-compatible clients
can use the server's MCP Apps resource.

| Tools | Dashboard |
|---|---|
| `analyze_run_performance`, `garmin_get_km_splits`, `garmin_get_activity_details` | Kilometre pace, HR and elevation when splits are requested; separate recorded laps, run metrics and HR drift when available |
| `get_training_trends` | Weekly distance, pace, and heart-rate charts |
| `garmin_get_heart_rate_zones` | Sport-profile tabs and colour-coded Z1-Z5 BPM ranges |
| `get_load_fatigue_model` | Fitness (CTL), fatigue (ATL), and balance (TSB) history |
| `get_readiness_score` | Readiness summary and positive/negative score contributions |
| `weekly_coach_brief` | Selected-versus-previous-week volume and coaching notes |
| `race_day_strategy` | Colour-coded target pace by race phase |

Dashboards include metric cards, chart details, underlying data, and the original
JSON. They support light/dark themes and narrow windows. Missing measurements are
shown as unavailable rather than invented as zeros. Zone ranges are configured
boundaries, **not time spent in zones**. Trend charts include zero-activity weeks
from the fetched history and flag that the first/current weeks can be partial.

#### Other clients: MCP Apps

Run `npm install` and `npm run build`, then restart/reconnect the MCP server in
your client so it discovers the new tool metadata and
`ui://garmin/fitness-report.html` resource. Ask for a run analysis, training trends,
or heart-rate zones as usual. The client must support the MCP Apps extension
(`io.modelcontextprotocol/ui`); a client that only supports standard MCP tools
will continue to receive the same JSON format and cannot display this dashboard.
The server cannot force a client to render HTML.

Charts render locally inside the client's sandbox using bundled JavaScript and
SVG. They use no external chart service, CDN, remote fonts, or analytics, and do
not persist fitness data in browser storage. The UI is read-only; it does not
create or modify Garmin workouts.

### GitHub Copilot desktop: native canvases

Install the personal extension from this repository:

```bash
npm install
npm run install:copilot
```

Then reload Copilot extensions in the current session, or restart the desktop
app to activate it in all sessions. The installer places a self-contained copy
under `$COPILOT_HOME/extensions/garmin-fitness` (normally
`~/.copilot/extensions/garmin-fitness`). It works across projects and chats,
without depending on this checkout's path or `node_modules`. Re-run the installer
after changing the dashboard or extension source.

Keep your existing Garmin MCP connection configured. Ask Copilot to analyze a
run, show training trends, or show your heart-rate zones. A tool-completion listener
saves results from the nine supported Garmin report tools **without opening tabs
for background data gathering**. Copilot then uses `garmin_fitness_reports` and
`garmin_fitness_show_report` to display only the report you requested in one
reusable **Fitness report** tab. For example, a run-analysis request shows the
analysis, not separate activity-detail and HR-zone tabs; a request for zones or
trends shows that report instead. Selecting a report consolidates older Garmin
tabs without deleting saved reports or closing unrelated canvases.

The extension also accepts the existing JSON-only Garmin
server, so no MCP server path change, extra login, or MCP Apps support is needed.
The original tool output is not replaced, and no extra Garmin request is made.

Each report is a timestamped snapshot, not a live feed. **Reload saved report**
reloads the selected snapshot; ask Copilot to run the Garmin tool again for fresh data.
Existing panels remain explicitly dated snapshots when a later Garmin request
fails. Malformed or truncated results produce a visible warning, never demo data.

To preserve reports across canvas/extension reloads, the extension stores JSON
under that Copilot session's `files/garmin-reports/` artifact directory, not in
this repository or a shared global fitness database. The files include the
original tool result and should be treated as personal health data. They use
owner-only permissions where supported and follow the session artifact lifecycle;
remove individual saved report files if you no longer want to retain them.
Deleting a file makes the corresponding canvas unavailable rather than fetching
or reconstructing it silently.

The renderer uses a read-only, token-protected HTTP server bound to `127.0.0.1`
on a temporary port. Servers close with their panels or extension process. No
Garmin credentials are copied into the extension, browser, or saved reports.
The installed extension itself can be disabled in Copilot's extension settings.

Source lives in `integrations/copilot/extension.mjs`, `src/copilot/`, and the
shared `src/ui/` renderer. `npm run build:ui` bundles both browser entry points;
`npm run build:copilot` packages the standalone native extension.

### Optional women's training and menstrual-health tools

- Symptom-led training context using local logs plus Garmin sleep/need, HRV,
  resting HR, Body Battery change, load/recovery, hydration, weight, VO2max,
  respiration, Pulse Ox, and skin temperature when available.
- Probabilistic cycle context that explicitly avoids universal phase-based
  training rules.
- Personal pattern comparison across completed Garmin-recorded cycles.
- Workload-based carbohydrate, protein, recovery, and hydration targets.
- Non-diagnostic energy-availability, RED-S, iron, bleeding, pregnancy, and
  bone-health guardrails.
- Sensitive Garmin menstrual/pregnancy reads behind a second opt-in.

The complete feature group is disabled by default. See
[Women's Training and Menstrual-Health Tools](docs/womens-training.md) for its
research basis, setup, privacy model, limitations, and references.

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

All women-specific tools, prompts, and server guidance are disabled by default,
so the standard MCP experience is unchanged. Enable them with:

```dotenv
I_AM_WOMAN=true
```

Garmin reproductive-health reads require a second opt-in because they use
undocumented consumer endpoints. After reviewing the linked privacy guidance,
enable both:

```dotenv
I_AM_WOMAN=true
GARMIN_WOMENS_HEALTH_ENABLED=true
```

Restart the MCP server after changing either setting.

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
| `garmin_get_km_splits` | Get actual 1 km distance splits, final partial km, pacing and recorded sensor metrics |
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
| `analyze_run_performance` | Analyze kilometre pacing, equal-distance halves, HR drift/decoupling, laps and intervals |
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

### Kilometre splits and run performance

**For run analysis or run performance, use `analyze_run_performance` for the
complete all-in-one report.** A normal run-performance request means all
available km splits, pacing/timing, heart-rate data, elevation/altitude in meters,
cadence, power, temperature and interval laps together, not just split times.
It fetches this data itself; the AI does not need separate activity-detail,
HR-data or km-splits calls for these measurements.

| What you ask | Tool workflow |
|---|---|
| "Analyze Garmin run 123456789" or "Show run performance" | `analyze_run_performance` with that `activity_id`, returning the full report |
| "Analyze my latest run" or "Analyze yesterday's run" | Find the running activity with `garmin_get_activities` or `garmin_search_activities`, then call `analyze_run_performance`; clarify if multiple runs match |
| "Only show kilometre splits for run 123456789" | `garmin_get_km_splits` with that `activity_id`; reserve this for explicit splits-only requests |

This routing is included in the MCP server's AI instructions, tool descriptions,
the `activity-deep-dive` prompt, and the native Copilot extension's guidance.
For a run analysis, the native extension displays only the analysis report,
not additional tabs for supporting tool calls.

Call `garmin_get_km_splits` with `{ "activity_id": 123456789 }` for distance
splits, or `analyze_run_performance` with the same ID for splits plus recorded
lap/interval analysis. Both read Garmin's cumulative distance/time stream,
requesting up to 100,000 chart samples without route coordinates. They do not
rename manual laps, mile laps, or interval reps as kilometres.

The `kilometre_splits.km_splits` array contains each 1,000 m segment and the
final partial segment, with numeric moving/elapsed/stopped seconds, cumulative
times, pace in seconds/km and `m:ss`, and pace change versus the previous segment
(positive means slower). Time-weighted average HR, maximum HR, cadence in total
steps/minute, power, temperature and sample-estimated ascent/descent/net elevation
plus start/end/minimum/maximum altitude in meters
are included when recorded. Missing values are `null`; sensor coverage is reported
per split. No generic HR zones or grade-adjusted paces are invented.

The pacing summary compares equal-distance halves, reports fastest/slowest full
kilometres and pace standard deviation, and labels an even split when the halves
differ by at most 2%. The partial final kilometre is excluded from full-km
comparisons. HR drift and speed/HR aerobic decoupling require at least 80% usable
HR coverage in each half. These are descriptive comparisons, not evidence of a
medical problem or a definitive fitness assessment, especially on hills, in heat,
or during intervals. Recorded work/recovery laps remain separate in run analysis.

Boundaries and sensor values are interpolated between samples, so results are
estimates at the recording resolution, not FIT-file-exact splits. Units come from
Garmin's descriptors, not their encoding `factor`. `data_quality.status` describes
timing coverage, not sensor completeness: missing start/end coverage leaves
unbracketed splits unavailable, gaps longer than 30 seconds produce warnings,
and missing moving time switches pace explicitly to elapsed time (including
pauses). Samples are never extrapolated or replaced with activity/lap averages.
Garmin can record a small initial GPS increment at zero elapsed/moving time.
When it is at most 10 m, the origin is anchored at that recorded timer start
with an explicit warning. Final distance differences of at most 0.01 m are
reconciled to the summary's decimal precision without changing recorded time.
Neither adjustment fills a genuinely missing start or end.
The splits-only tool returns an error if no segment can be calculated; run analysis
can still return its recorded laps with an explicit unavailable-splits warning.

Rebuild and reconnect the MCP server to discover the new tool. If using the
native Copilot extension, also rerun `npm run install:copilot` and reload extensions
to enable capture of the new tool and kilometre charts.

If merged changes still return the old report without `kilometre_splits`,
pulling source alone is not enough: run `npm run build` in the checkout used by
the MCP client's configured `dist/index.js` command, then restart/reconnect that
MCP server. Reloading the canvas extension does not restart the Garmin MCP server.

### Women's training and menstrual health

This entire tool group is registered only when `I_AM_WOMAN=true`.

| Tool | Description |
|---|---|
| `women_set_health_profile` | Store life stage, contraception context, and usual cycle details locally |
| `women_log_daily_health` | Log period events, symptoms, subjective recovery, and session response |
| `women_delete_cycle_event` | Correct a locally recorded cycle event |
| `women_get_cycle_context` | Estimate calendar context with explicit uncertainty and no phase-only training rule |
| `garmin_get_recovery_snapshot` | Read Garmin recovery, sleep, load, hydration, and biometric context |
| `garmin_get_extended_wellness` | Return raw Body Battery and all-day stress data |
| `women_get_training_context` | Combine symptoms, cycle context, and Garmin recovery |
| `women_get_nutrition_targets` | Calculate workload-based fueling and hydration ranges |
| `women_estimate_energy_availability` | Produce a non-diagnostic EA estimate with uncertainty |
| `women_screen_training_health` | Educational triage for menstrual, iron, bone, pregnancy, and under-fueling concerns |
| `women_analyze_cycle_training_patterns` | Compare personal patterns across completed cycles using Garmin activities |

With both `I_AM_WOMAN=true` and
`GARMIN_WOMENS_HEALTH_ENABLED=true`, the server additionally registers:

- `garmin_get_menstrual_day`
- `garmin_get_menstrual_calendar`
- `garmin_get_pregnancy_summary`

Garmin does not publish the private response schema, so these tools return
opaque JSON and unverified date candidates rather than inventing period-start
fields.

## Development

```bash
npm run dev
npm run build
npm test
npm start
```

The server uses stdio transport. Runtime messages are sent to stderr so stdout
remains valid MCP protocol output.

`npm run build` compiles the server, bundles both dashboard entry points, and
packages the Copilot extension into `dist/copilot/garmin-fitness/`.
`npm run dev` rebuilds UI assets before starting the TypeScript server; restart
it after UI edits. No manually managed web server is needed.

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

Never commit credentials, OAuth tokens, Garmin session files, MFA codes, raw
reproductive-health responses, or live SQLite databases. The repository ignore
rules cover current Garmin state and legacy archived token files.

## License

ISC
