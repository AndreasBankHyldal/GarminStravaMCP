import { randomUUID } from "node:crypto";

interface InteractiveMfaClient {
  client: {
    mfaManager: {
      waitForMFACode(sessionId: string, timeout?: number): Promise<string>;
    };
  };
  login(username: string, password: string, sessionId: string): Promise<unknown>;
}

export async function loginWithInteractiveMfa(
  client: InteractiveMfaClient,
  username: string,
  password: string,
  requestCode: () => Promise<string>,
): Promise<void> {
  const manager = client.client.mfaManager;
  const originalWait = manager.waitForMFACode;
  // The pinned library's file-based submitter logs the code. Keep this CLI session in memory instead.
  manager.waitForMFACode = async (_sessionId, timeout = 5 * 60_000) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([
        requestCode(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Garmin MFA verification timed out")), timeout);
        }),
      ]);
      if (!code.trim()) throw new Error("No Garmin MFA verification code given");
      return code.trim();
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await client.login(username, password, `garmin-auth-${randomUUID()}`);
  } finally {
    manager.waitForMFACode = originalWait;
  }
}
