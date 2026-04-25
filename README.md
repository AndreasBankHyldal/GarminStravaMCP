# MCP Strava & Garmin Connect Server

An MCP (Model Context Protocol) server that integrates with **Strava** and **Garmin Connect**, letting your AI assistant fetch activities, analyze run performance, plan training, and track fitness stats.

## Features

### 🏃 Strava Integration
- Fetch recent activities with filters
- Get detailed activity data (laps, splits, heart rate, pace)
- View athlete stats (totals, year-to-date)
- Get time-series data streams (HR, pace, elevation, cadence)

### ⌚ Garmin Connect Integration
- Fetch activities from Garmin Connect
- Get fitness stats (VO2max, training load)
- Heart rate data (resting HR, daily HR)
- Sleep data and scores
- Daily step counts

### 📊 Analysis
- Run performance analysis (pace consistency, HR drift, split analysis)
- Training trends over weeks/months (weekly mileage, pace trends)
- Compare Strava vs Garmin data for the same activity

### 📋 Training Plans
- Create multi-week training plans
- Track planned workouts (easy run, tempo, intervals, long run, etc.)
- Check plan compliance against actual activities

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
2. Set the "Authorization Callback Domain" to `localhost`
3. Copy your **Client ID** and **Client Secret** into `.env`
4. Run the one-time OAuth flow:

```bash
npm run strava-auth
```

This opens a browser for authorization and saves your tokens automatically.

#### Garmin Connect Setup
Add your Garmin Connect username and password to `.env`:

```
GARMIN_USERNAME=your.email@example.com
GARMIN_PASSWORD=your_password
```

> ⚠️ Garmin uses an unofficial API. MFA may require manual intervention. Session tokens are cached to minimize logins.

### 3. Configure your MCP client

#### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "strava-garmin": {
      "command": "node",
      "args": ["/FULL/PATH/TO/mcpStravaGarmin/dist/index.js"],
      "env": {
        "STRAVA_CLIENT_ID": "your_client_id",
        "STRAVA_CLIENT_SECRET": "your_client_secret",
        "GARMIN_USERNAME": "your_email",
        "GARMIN_PASSWORD": "your_password"
      }
    }
  }
}
```

#### VS Code (Copilot)

Add to your VS Code settings or `.vscode/mcp.json`:

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

| Tool | Description |
|------|-------------|
| `strava_get_activities` | Fetch recent Strava activities |
| `strava_get_activity_details` | Get detailed data for a Strava activity |
| `strava_get_athlete_stats` | Get athlete totals and stats |
| `strava_get_activity_streams` | Get time-series data (HR, pace, etc.) |
| `garmin_get_activities` | Fetch recent Garmin activities |
| `garmin_get_activity_details` | Get detailed Garmin activity data |
| `garmin_get_fitness_stats` | Get fitness profile and stats |
| `garmin_get_heart_rate` | Get heart rate data for a date |
| `garmin_get_sleep` | Get sleep data for a date |
| `garmin_get_steps` | Get step count for a date |
| `analyze_run_performance` | Deep analysis of a run (splits, HR drift) |
| `compare_activities` | Compare Strava vs Garmin data |
| `get_training_trends` | Weekly training volume and trends |
| `create_training_plan` | Create a training plan with workouts |
| `get_training_plan` | View a training plan |
| `update_training_plan` | Modify a training plan |
| `check_plan_compliance` | Check adherence to training plan |

## Example Prompts

Once connected, try asking your AI assistant:

- *"Show me my last 10 runs from Strava"*
- *"Analyze my most recent run — how consistent was my pacing?"*
- *"What's my weekly mileage trend over the last 8 weeks?"*
- *"Compare my last run between Strava and Garmin"*
- *"Create a 4-week half marathon training plan starting next Monday"*
- *"How well am I following my training plan?"*
- *"What was my sleep quality last night?"*
- *"What's my current VO2max and resting heart rate?"*

## Development

```bash
# Run with tsx (hot reload)
npm run dev

# Build TypeScript
npm run build

# Run built version
npm start
```

## Rate Limits

- **Strava**: 100 requests per 15 minutes, 1000 per day
- **Garmin**: Unofficial API — be conservative with requests

## License

ISC
