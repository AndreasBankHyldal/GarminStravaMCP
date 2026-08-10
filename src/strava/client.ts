import { getAccessToken } from "./auth.js";

const BASE_URL = "https://www.strava.com/api/v3";

export function stravaApiError(status: number, body: string): Error {
  if (
    status === 403 &&
    /"resource"\s*:\s*"Application"/i.test(body) &&
    /"field"\s*:\s*"Status"/i.test(body) &&
    /"code"\s*:\s*"Inactive"/i.test(body)
  ) {
    return new Error(
      "Strava API error 403: this API application is inactive. Resolve its status at " +
      "https://www.strava.com/settings/api, then run `npm run strava-auth` again. " +
      "Garmin tools can still be used meanwhile."
    );
  }

  if (
    status === 404 &&
    /"resource"\s*:\s*"Activity"/i.test(body) &&
    (
      /"code"\s*:\s*"not found"/i.test(body) ||
      /"code"\s*:\s*"invalid"/i.test(body) ||
      /"message"\s*:\s*"Record Not Found"/i.test(body)
    )
  ) {
    return new Error(
      "Strava API error 404: activity not found. Use an ID returned by a Strava tool, " +
      "or call `analyze_run_performance` with source `garmin` for a Garmin activity ID."
    );
  }

  return new Error(`Strava API error ${status}: ${body}`);
}

async function stravaFetch<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`${BASE_URL}${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw stravaApiError(resp.status, body);
  }

  return resp.json() as Promise<T>;
}

export interface StravaActivity {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  start_date: string;
  start_date_local: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  average_speed: number;
  max_speed: number;
  average_heartrate?: number;
  max_heartrate?: number;
  calories?: number;
  suffer_score?: number;
  description?: string;
  laps?: StravaLap[];
  splits_metric?: StravaSplit[];
}

export interface StravaLap {
  name: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  average_speed: number;
  average_heartrate?: number;
  max_heartrate?: number;
  lap_index: number;
}

export interface StravaSplit {
  distance: number;
  elapsed_time: number;
  moving_time: number;
  average_speed: number;
  average_heartrate?: number;
  split: number;
}

export interface StravaAthleteStats {
  recent_run_totals: StravaTotals;
  all_run_totals: StravaTotals;
  ytd_run_totals: StravaTotals;
  recent_ride_totals: StravaTotals;
  all_ride_totals: StravaTotals;
  ytd_ride_totals: StravaTotals;
}

export interface StravaTotals {
  count: number;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  elevation_gain: number;
}

export interface StravaStream {
  type: string;
  data: number[];
  series_type: string;
  original_size: number;
  resolution: string;
}

export async function getActivities(
  page = 1,
  perPage = 30,
  after?: number,
  before?: number
): Promise<StravaActivity[]> {
  const params: Record<string, string> = {
    page: String(page),
    per_page: String(perPage),
  };
  if (after) params.after = String(after);
  if (before) params.before = String(before);

  return stravaFetch<StravaActivity[]>("/athlete/activities", params);
}

export async function getActivityDetails(id: number): Promise<StravaActivity> {
  return stravaFetch<StravaActivity>(`/activities/${id}`);
}

export async function getAthleteStats(): Promise<StravaAthleteStats> {
  const athlete = await stravaFetch<{ id: number }>("/athlete");
  return stravaFetch<StravaAthleteStats>(`/athletes/${athlete.id}/stats`);
}

export async function getActivityStreams(
  id: number,
  keys: string[] = ["time", "heartrate", "velocity_smooth", "altitude", "cadence", "distance"]
): Promise<StravaStream[]> {
  return stravaFetch<StravaStream[]>(
    `/activities/${id}/streams`,
    { keys: keys.join(","), key_type: "time" }
  );
}

export async function createManualActivity(params: {
  name: string;
  sport_type: string;
  start_date_local: string;
  elapsed_time: number;
  distance?: number;
  description?: string;
}): Promise<StravaActivity> {
  const token = await getAccessToken();
  const resp = await fetch(`${BASE_URL}/activities`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });

  if (!resp.ok) {
    throw stravaApiError(resp.status, await resp.text());
  }
  return resp.json() as Promise<StravaActivity>;
}

export async function updateActivity(
  id: number,
  params: { name?: string; description?: string; sport_type?: string }
): Promise<StravaActivity> {
  const token = await getAccessToken();
  const resp = await fetch(`${BASE_URL}/activities/${id}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });

  if (!resp.ok) {
    throw stravaApiError(resp.status, await resp.text());
  }
  return resp.json() as Promise<StravaActivity>;
}
