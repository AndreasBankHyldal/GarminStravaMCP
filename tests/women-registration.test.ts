import assert from "node:assert/strict";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../src/config.js";
import { registerWomenTools } from "../src/women/tools.js";

function registeredToolNames(): string[] {
  const server = new McpServer({
    name: "women-registration-test",
    version: "1",
  });
  registerWomenTools(server);
  const registry = server as unknown as {
    _registeredTools: Record<string, unknown>;
  };
  return Object.keys(registry._registeredTools);
}

test("women tools are absent unless the master opt-in is enabled", () => {
  const originalWomen = config.women.toolsEnabled;
  const originalSensitive = config.garmin.womenHealthEnabled;
  try {
    config.women.toolsEnabled = false;
    config.garmin.womenHealthEnabled = true;
    assert.deepEqual(registeredToolNames(), []);
  } finally {
    config.women.toolsEnabled = originalWomen;
    config.garmin.womenHealthEnabled = originalSensitive;
  }
});

test("master opt-in exposes standard tools but not reproductive Garmin reads", () => {
  const originalWomen = config.women.toolsEnabled;
  const originalSensitive = config.garmin.womenHealthEnabled;
  try {
    config.women.toolsEnabled = true;
    config.garmin.womenHealthEnabled = false;
    const names = registeredToolNames();
    assert.equal(names.length, 11);
    assert.ok(names.includes("women_get_training_context"));
    assert.ok(!names.includes("garmin_get_menstrual_calendar"));
  } finally {
    config.women.toolsEnabled = originalWomen;
    config.garmin.womenHealthEnabled = originalSensitive;
  }
});

test("both opt-ins expose the three sensitive Garmin tools", () => {
  const originalWomen = config.women.toolsEnabled;
  const originalSensitive = config.garmin.womenHealthEnabled;
  try {
    config.women.toolsEnabled = true;
    config.garmin.womenHealthEnabled = true;
    const names = registeredToolNames();
    assert.equal(names.length, 14);
    assert.ok(names.includes("garmin_get_menstrual_day"));
    assert.ok(names.includes("garmin_get_menstrual_calendar"));
    assert.ok(names.includes("garmin_get_pregnancy_summary"));
  } finally {
    config.women.toolsEnabled = originalWomen;
    config.garmin.womenHealthEnabled = originalSensitive;
  }
});
