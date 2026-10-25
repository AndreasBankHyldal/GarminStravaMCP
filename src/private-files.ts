import fs from "node:fs";

export function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
}

export function ensurePrivateFile(file: string): void {
  const descriptor = fs.openSync(file, "a", 0o600);
  try {
    if (process.platform !== "win32") fs.fchmodSync(descriptor, 0o600);
  } finally {
    fs.closeSync(descriptor);
  }
}
