import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { config } from "../config.js";

export const OWNER_USER_ID = "owner";
const USER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Everything that differs between the people sharing one hosted server. */
export interface UserContext {
  id: string;
  garminTokenDir: string;
  garminMfaDir: string;
  dbPath: string;
  /** Only the owner may have credentials; other users authenticate with uploaded tokens. */
  garminUsername: string;
  garminPassword: string;
}

const storage = new AsyncLocalStorage<UserContext>();

export function isValidUserId(id: string): boolean {
  return USER_ID_PATTERN.test(id) && id !== OWNER_USER_ID;
}

/** The single-user (stdio) context, backed by the existing state layout and .env credentials. */
export function ownerContext(): UserContext {
  return {
    id: OWNER_USER_ID,
    garminTokenDir: config.paths.garminTokenDir,
    garminMfaDir: config.paths.garminMfaDir,
    dbPath: config.dbPath,
    garminUsername: config.garmin.username,
    garminPassword: config.garmin.password,
  };
}

/** Per-user state under `<stateDir>/users/<id>/`, mirroring the owner's layout. */
export function userContextFor(stateDir: string, id: string): UserContext {
  if (!isValidUserId(id)) throw new Error(`Invalid user id: ${id}`);
  const dir = path.join(stateDir, "users", id);
  return {
    id,
    garminTokenDir: path.join(dir, ".garmin-tokens"),
    garminMfaDir: path.join(dir, ".garmin-mfa"),
    dbPath: path.join(dir, "data", "training.db"),
    garminUsername: "",
    garminPassword: "",
  };
}

export function currentUser(): UserContext {
  return storage.getStore() ?? ownerContext();
}

export function runAsUser<T>(user: UserContext, fn: () => T): T {
  return storage.run(user, fn);
}
