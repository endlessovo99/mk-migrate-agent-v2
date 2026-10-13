import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { digest, requireValue, writeJson } from "./common.mjs";

const TOOL = fileURLToPath(new URL("./", import.meta.url));
const ROOT = resolve(TOOL, "../..");
const files = ["common.mjs", "schedule.mjs", "intake.mjs", "clean-command.mjs", "prompt.mjs", "evidence.mjs", "repair.mjs", "worker.mjs", "controller.mjs", "cli.mjs", "linux-metrics.mjs", "metrics.mjs", "config.example.json", "install.sh"];

export function packageScheduler(out) {
  out = resolve(out);
  mkdirSync(out, { mode: 0o700 });
  const stage = join(out, "mk-codex-scheduler");
  mkdirSync(stage, { mode: 0o700 });
  for (const name of files) cpSync(join(TOOL, name), join(stage, name));
  cpSync(join(ROOT, "skills/mk-migrate-server"), join(stage, "mk-migrate-server"), { recursive: true, dereference: false });
  cpSync(join(ROOT, "docs/operations/codex-session-scheduler.md"), join(stage, "INSTALL.md"));
  const manifest = [];
  function visit(path, prefix = "") {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      requireValue(!entry.isSymbolicLink(), "Package cannot contain symlinks");
      const name = prefix + entry.name;
      if (entry.isDirectory()) visit(join(path, entry.name), `${name}/`);
      else { manifest.push(`${digest(readFileSync(join(path, entry.name)))}  ${name}`); chmodSync(join(path, entry.name), entry.name.endsWith(".sh") ? 0o700 : 0o600); }
    }
  }
  visit(stage);
  writeFileSync(join(stage, "MANIFEST.sha256"), manifest.join("\n") + "\n", { mode: 0o600 });
  const archive = join(out, "mk-codex-scheduler.tar.gz");
  const tar = spawnSync("tar", ["-czf", archive, "-C", out, basename(stage)], { env: { ...process.env, COPYFILE_DISABLE: "1" }, encoding: "utf8" });
  requireValue(tar.status === 0, "Scheduler packaging failed");
  chmodSync(archive, 0o600);
  writeFileSync(`${archive}.sha256`, `${digest(readFileSync(archive))}  ${basename(archive)}\n`, { mode: 0o600 });
  cpSync(join(stage, "INSTALL.md"), join(out, "INSTALL.md"));
  writeJson(join(out, "release.json"), { version: 6, createdAt: new Date().toISOString(), archive: basename(archive), sha256: digest(readFileSync(archive)),
    contents: "Scheduler and server operator skill only; no engine, XML, model auth or NewOA credentials." }, { exclusive: true });
  return { directory: out, archive, checksum: `${archive}.sha256`, instructions: join(out, "INSTALL.md") };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { requireValue(process.argv.length === 3, "Usage: node package.mjs <new-output-directory>"); console.log(JSON.stringify(packageScheduler(process.argv[2]), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
