import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isValidUserId, userContextFor, type UserContext } from "./context.js";

export interface StoredUser {
  id: string;
  /** SHA-256 (hex) of the user's bearer token; the token itself is never stored. */
  tokenSha256: string;
  createdAt: string;
}

interface UsersFile {
  users: StoredUser[];
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export function usersFilePath(stateDir: string): string {
  return path.join(stateDir, "users.json");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function readUsers(stateDir: string): StoredUser[] {
  const file = usersFilePath(stateDir);
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<UsersFile>;
  if (!Array.isArray(parsed.users)) throw new Error(`${file} must contain a "users" array`);
  const seen = new Set<string>();
  for (const user of parsed.users) {
    if (!user || typeof user.id !== "string" || !isValidUserId(user.id)) {
      throw new Error(`${file}: invalid user id ${JSON.stringify(user?.id)}`);
    }
    if (typeof user.tokenSha256 !== "string" || !HASH_PATTERN.test(user.tokenSha256)) {
      throw new Error(`${file}: user ${user.id} has an invalid tokenSha256`);
    }
    if (seen.has(user.id)) throw new Error(`${file}: duplicate user id ${user.id}`);
    seen.add(user.id);
  }
  return parsed.users;
}

export function writeUsers(stateDir: string, users: StoredUser[]): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = usersFilePath(stateDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ users }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function sameHash(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export interface UserRegistry {
  /** Resolve a presented bearer token to its user, or null. */
  authenticate(token: string): UserContext | null;
  /** Resolve an OAuth grant only while its original credential is still valid. */
  resolveGrant(userId: string, credentialHash: string): UserContext | null;
}

/**
 * Owner (MCP_AUTH_TOKEN, existing state layout) plus the users in `<stateDir>/users.json`.
 * The file is re-read when it changes, so `users add` takes effect without a restart.
 */
export function createUserRegistry(options: {
  stateDir: string;
  owner: UserContext;
  ownerToken: string;
  /**
   * Called when a user is removed, re-created or gets a new token, so cached sessions and
   * database handles from the previous incarnation are dropped before the next request.
   */
  onUserInvalidated?: (user: UserContext) => void;
}): UserRegistry {
  const ownerHash = hashToken(options.ownerToken);
  const file = usersFilePath(options.stateDir);
  let cachedStamp = "";
  let cached: StoredUser[] = [];

  function users(): StoredUser[] {
    let stamp = "missing";
    try {
      const stat = fs.statSync(file);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      // No users file: owner only.
    }
    if (stamp !== cachedStamp) {
      try {
        const next = stamp === "missing" ? [] : readUsers(options.stateDir);
        const nextById = new Map(next.map((user) => [user.id, user]));
        for (const previous of cached) {
          const current = nextById.get(previous.id);
          if (!current || current.tokenSha256 !== previous.tokenSha256 || current.createdAt !== previous.createdAt) {
            options.onUserInvalidated?.(userContextFor(options.stateDir, previous.id));
          }
        }
        cached = next;
        cachedStamp = stamp;
      } catch (err) {
        // Keep serving the last valid list rather than locking everyone out.
        console.error(`Ignoring invalid users file: ${(err as Error).message}`);
      }
    }
    return cached;
  }

  return {
    resolveGrant(userId: string, credentialHash: string): UserContext | null {
      if (!HASH_PATTERN.test(credentialHash)) return null;
      const entries = users();
      if (userId === options.owner.id && sameHash(credentialHash, ownerHash)) return options.owner;
      const user = entries.find((entry) => entry.id === userId);
      return user && sameHash(credentialHash, user.tokenSha256)
        ? userContextFor(options.stateDir, user.id)
        : null;
    },
    authenticate(token: string): UserContext | null {
      if (!token) return null;
      const presented = hashToken(token);
      // Compare against every entry so timing doesn't reveal which one matched.
      let match: UserContext | null = sameHash(presented, ownerHash) ? options.owner : null;
      for (const user of users()) {
        if (sameHash(presented, user.tokenSha256) && !match) {
          match = userContextFor(options.stateDir, user.id);
        }
      }
      return match;
    },
  };
}
