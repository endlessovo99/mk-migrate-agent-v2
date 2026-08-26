import { fileURLToPath } from "node:url";
import { config } from "dotenv";

export const DEFAULT_ENV_FILE = fileURLToPath(new URL("../.tmp/newoa.env", import.meta.url));

export function loadDefaultEnvironment({ path = DEFAULT_ENV_FILE, env = process.env } = {}) {
  const result = config({
    path,
    processEnv: env,
    override: false,
    quiet: true
  });

  if (!result.error) return true;
  if (result.error.code === "ENOENT") return false;
  throw result.error;
}
