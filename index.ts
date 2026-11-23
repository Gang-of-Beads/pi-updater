import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  VERSION,
  BorderedLoader,
  DefaultPackageManager,
  SettingsManager,
  getAgentDir,
  parseArgs,
} from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
function cacheFile(): string {
  return join(process.env.PI_UPDATER_CACHE_DIR ?? getAgentDir(), "update-cache.json");
}
const UPDATE_COMMANDS = {
  self: { args: ["update", "--self"], display: "pi update --self" },
  extensions: { args: ["update", "--extensions"], display: "pi update --extensions" },
  all: { args: ["update", "--all"], display: "pi update --all" },
} as const;

type UpdateTarget = keyof typeof UPDATE_COMMANDS;

interface UpdateOffer {
  piLatest?: string;
  extensions: string[];
}

const ENV_SKIP_VERSION_CHECK = "PI_SKIP_VERSION_CHECK";
const ENV_OFFLINE = "PI_OFFLINE";
const ENV_INTERNAL_SKIP = "PI_UPDATER_SUPPRESSED_NATIVE_VERSION_CHECK";
// One-shot: set on the pi process we restart into after an update, so the
// user is not immediately notified about updates they just declined.
const ENV_SUPPRESS_STARTUP_CHECK = "PI_UPDATER_SUPPRESS_STARTUP_CHECK";

interface VersionCache {
  latestVersion: string;
  dismissedVersion?: string;
  /** A version the user already acted on (chose an update for); never re-prompted until a newer one appears. */
  actedVersion?: string;
  checkedAt?: string;
  /**
   * Extension update sets the user already answered, keyed by the sorted
   * update list. The decision is machine-level on purpose: answering in one
   * session must silence every other session's prompt for the same set -
   * the owner reported the same extension prompt more than ten times.
   */
  settledExtensionSets?: string[];
  /**
   * Versions this machine has already been asked about. The offer is one
   * popup per version per machine: the owner sees every session of a
   * long-lived host as the same seat, so a prompt answered - or closed -
   * anywhere must not return anywhere else.
   */
  promptedVersions?: string[];
}

/** Record that this machine has seen the offer for `version`. */
function notePromptedVersion(version: string) {
  const prev = readCache();
  const prompted = new Set(prev?.promptedVersions ?? []);
  prompted.add(version);
  writeCache({
    latestVersion: prev?.latestVersion ?? version,
    dismissedVersion: prev?.dismissedVersion,
    actedVersion: prev?.actedVersion,
    checkedAt: prev?.checkedAt,
    settledExtensionSets: prev?.settledExtensionSets,
    promptedVersions: [...prompted].slice(-16),
  });
}

export function extensionSetKey(extensions: string[]): string {
  return [...extensions].sort().join("\u0000");
}

function settleExtensionSet(extensions: string[]) {
  if (extensions.length === 0) return;
  const prev = readCache();
  const settled = new Set(prev?.settledExtensionSets ?? []);
  settled.add(extensionSetKey(extensions));
  writeCache({
    latestVersion: prev?.latestVersion ?? "",
    dismissedVersion: prev?.dismissedVersion,
    actedVersion: prev?.actedVersion,
    checkedAt: prev?.checkedAt,
    settledExtensionSets: [...settled].slice(-16),
    promptedVersions: prev?.promptedVersions,
  });
}

export function unsettledExtensions(extensions: string[]): string[] {
  if (extensions.length === 0) return [];
  const settled = new Set(readCache()?.settledExtensionSets ?? []);
  return settled.has(extensionSetKey(extensions)) ? [] : extensions;
}

function readCache(): VersionCache | undefined {
  try {
    // An unreadable or incomplete cache is no cache: a half-written file must not reach the caller.
    const cache: unknown = JSON.parse(readFileSync(cacheFile(), "utf-8"));
    if (typeof cache !== "object" || cache === null) return undefined;
    const { latestVersion, dismissedVersion, checkedAt, actedVersion, settledExtensionSets, promptedVersions } = cache as Record<string, unknown>;
    if (typeof latestVersion !== "string") return undefined;
    if (dismissedVersion !== undefined && typeof dismissedVersion !== "string") return undefined;
    if (checkedAt !== undefined && typeof checkedAt !== "string") return undefined;
    if (actedVersion !== undefined && typeof actedVersion !== "string") return undefined;
    const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
    return {
      latestVersion, dismissedVersion, checkedAt, actedVersion,
      settledExtensionSets: strings(settledExtensionSets),
      promptedVersions: strings(promptedVersions),
    };
  } catch {
    return undefined;
  }
}

function writeCache(cache: VersionCache) {
  try {
    mkdirSync(dirname(cacheFile()), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify(cache) + "\n");
  } catch {}
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = version
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!match) return undefined;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4],
  };
}

function isNewer(candidate: string, current: string): boolean {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  if (!left || !right) return false;
  if (left.major !== right.major) return left.major > right.major;
  if (left.minor !== right.minor) return left.minor > right.minor;
  if (left.patch !== right.patch) return left.patch > right.patch;
  if (left.prerelease === right.prerelease) return false;
  if (!left.prerelease) return true;
  if (!right.prerelease) return false;
  return left.prerelease.localeCompare(right.prerelease) > 0;
}

function isEnvSet(name: string): boolean {
  return Boolean(process.env[name]);
}

const userSkippedVersionCheck =
  isEnvSet(ENV_SKIP_VERSION_CHECK) && !isEnvSet(ENV_INTERNAL_SKIP);

function shouldSkipAutoChecks(): boolean {
  return userSkippedVersionCheck || isEnvSet(ENV_OFFLINE);
}

function isOffline(): boolean {
  return isEnvSet(ENV_OFFLINE);
}

function piUserAgent(): string {
  const runtime = process.versions.bun
    ? `bun/${process.versions.bun}`
    : `node/${process.version}`;
  return `pi/${VERSION} (${process.platform}; ${runtime}; ${process.arch})`;
}

async function fetchLatestVersion(): Promise<string | undefined> {
  try {
    const res = await fetch(LATEST_VERSION_URL, {
      headers: {
        "User-Agent": piUserAgent(),
        accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { version?: string };
    if (typeof data.version !== "string" || !data.version.trim()) return undefined;
    return data.version.trim();
  } catch {
    return undefined;
  }
}

function createPackageManager(ctx: ExtensionContext): DefaultPackageManager {
  const cwd = ctx.cwd;
  // SettingsManager.create assumes a trusted project by default, so pass
  // pi's trust decision; otherwise an untrusted project's settings apply.
  const projectTrusted = ctx.isProjectTrusted();
  const agentDir = getAgentDir();
  return new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted }),
  });
}

/**
 * Check for outdated extension packages using pi's own package manager —
 * the same code path behind pi's startup "Package Updates Available" banner.
 * Network or npm failures and a stale ctx mean no extension offer.
 */
async function checkForExtensionUpdates(ctx: ExtensionContext): Promise<string[]> {
  try {
    const updates = await createPackageManager(ctx).checkForAvailableUpdates();
    return updates.map((update) => update.displayName);
  } catch {
    return [];
  }
}

/** Returns a cached upgrade version if available and not dismissed or already acted on. */
function getCachedUpgradeVersion(): string | undefined {
  const cache = readCache();
  if (!cache) return undefined;
  if (!isNewer(cache.latestVersion, VERSION)) return undefined;
  if (cache.dismissedVersion === cache.latestVersion) return undefined;
  if (cache.actedVersion === cache.latestVersion) return undefined;
  return cache.latestVersion;
}

/**
 * What is installed for every configured package: its package.json version
 * and, for a git checkout, its commit. Undefined when that cannot be read.
 */
async function readPackageRevisions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<string | undefined> {
  try {
    const revisions: string[] = [];
    for (const { source, scope, installedPath } of createPackageManager(ctx).listConfiguredPackages()) {
      if (!installedPath) continue;
      let version: string | undefined;
      try {
        const manifest = JSON.parse(readFileSync(join(installedPath, "package.json"), "utf-8"));
        if (typeof manifest.version === "string") version = manifest.version;
      } catch {
        // No readable package.json: the commit below still identifies a git package.
      }
      let commit: string | undefined;
      if (existsSync(join(installedPath, ".git"))) {
        const git = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: installedPath, timeout: 10_000 });
        commit = git.stdout.trim();
        if (git.code !== 0 || git.killed || !commit) throw new Error(`No commit for ${source}`);
      }
      // Two unreadable snapshots would compare equal and hide a real update.
      if (version === undefined && commit === undefined) throw new Error(`No revision for ${source}`);
      revisions.push([scope, source, version, commit].join(" "));
    }
    return revisions.join("\n");
  } catch {
    return undefined;
  }
}

function saveLatestToCache(latest: string) {
  const prev = readCache();
  writeCache({
    latestVersion: latest,
    dismissedVersion: prev?.dismissedVersion,
    actedVersion: prev?.actedVersion,
    checkedAt: new Date().toISOString(),
    settledExtensionSets: prev?.settledExtensionSets,
    promptedVersions: prev?.promptedVersions,
  });
}

/** Fetch latest from Pi's update endpoint and refresh cache. */
async function refreshLatestVersionInCache(): Promise<string | undefined> {
  const latest = await fetchLatestVersion();
  if (!latest) return undefined;
  saveLatestToCache(latest);
  return latest;
}

function dismissVersion(version: string) {
  const cache = readCache();
  writeCache({
    latestVersion: cache?.latestVersion ?? version,
    dismissedVersion: version,
    actedVersion: cache?.actedVersion,
    checkedAt: cache?.checkedAt,
    settledExtensionSets: cache?.settledExtensionSets,
    promptedVersions: cache?.promptedVersions,
  });
}

/** The user chose an update for this version: never re-prompt it (a newer version still prompts). */
function actOnVersion(version: string) {
  const cache = readCache();
  writeCache({
    latestVersion: cache?.latestVersion ?? version,
    dismissedVersion: cache?.dismissedVersion,
    actedVersion: version,
    checkedAt: cache?.checkedAt,
  });
}

/**
 * What answering an update prompt records: the version dismissed or acted on,
 * and the extension set settled. The demo answers with none of them recorded,
 * so trying `/update --test` never silences a real offer.
 */
interface UpdateDecisions {
  dismissVersion(version: string): void;
  actOnVersion(version: string): void;
  settleExtensionSet(extensions: string[]): void;
}

const RECORDED_DECISIONS: UpdateDecisions = { dismissVersion, actOnVersion, settleExtensionSet };
const UNRECORDED_DECISIONS: UpdateDecisions = {
  dismissVersion: () => {},
  actOnVersion: () => {},
  settleExtensionSet: () => {},
};

/**
 * The recurrence decision, pure and exported for tests: prompt for `latest`
 * only when it is newer than the running version, not already prompted in
 * this process, not dismissed, and not already acted on (the owner-reported
 * defect: an installed update kept re-prompting because acting recorded
 * nothing and the running version only changes after a restart).
 */
export function shouldPromptForVersion(input: {
  latest: string;
  runningVersion: string;
  cache: VersionCache | undefined;
  prompted: ReadonlySet<string>;
}): boolean {
  if (!isNewer(input.latest, input.runningVersion)) return false;
  if (input.prompted.has(input.latest)) return false;
  if (input.cache?.promptedVersions?.includes(input.latest) === true) return false;
  if (input.cache?.dismissedVersion === input.latest) return false;
  if (input.cache?.actedVersion === input.latest) return false;
  return true;
}

/**
 * Version of the pi package a restart would launch: the package that owns
 * process.argv[1] now. npm replaces that package in place and pnpm repoints
 * its symlink, so the version changes. Installs that keep versions side by
 * side (pi.dev installer, custom update commands) leave it unchanged.
 */
function readRestartPiVersion(): string | undefined {
  try {
    let dir = dirname(realpathSync(process.argv[1]));
    while (!existsSync(join(dir, "package.json"))) {
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
    const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

function isBunFsPath(path: string): boolean {
  return path.includes("$bunfs") || path.includes("~BUN") || path.includes("%7EBUN");
}

/**
 * Command that re-invokes the currently running pi, regardless of what
 * `pi` on PATH points to. For Node installs this is `node <entrypoint>`;
 * for Bun standalone binaries the executable itself is pi.
 */
function currentPiCommand(args: string[]): { program: string; args: string[] } {
  const entry = process.argv[1];
  if (entry && !isBunFsPath(entry)) {
    return { program: process.execPath, args: [entry, ...args] };
  }
  return { program: process.execPath, args };
}

// The restart passes the current session itself.
const SESSION_FLAGS = new Set(["--continue", "-c", "--resume", "-r", "--no-session"]);
const SESSION_FLAGS_WITH_VALUE = new Set(["--session", "--session-id", "--fork"]);

/**
 * The arguments pi was started with, minus what must not apply twice: the
 * first prompt and attached files, and the flags that select a session.
 * A saved conversation restores its model, thinking level and name.
 * Return undefined when the arguments cannot be replayed safely.
 */
function restartFlags(argv: string[], restoresSessionState: boolean, restoresSessionName: boolean): string[] | undefined {
  const original = parseArgs(argv);
  // A key may rely on a scoped model that pi will not select on resume.
  if (original.apiKey !== undefined) return undefined;
  const droppedWithValue = new Set(SESSION_FLAGS_WITH_VALUE);
  if (restoresSessionState) {
    for (const flag of ["--provider", "--model", "--thinking"]) {
      droppedWithValue.add(flag);
    }
  }
  if (restoresSessionName) {
    droppedWithValue.add("--name");
    droppedWithValue.add("-n");
  }
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (droppedWithValue.has(arg)) {
      i++;
      continue;
    }
    if (SESSION_FLAGS.has(arg)) continue;
    // Pi's own parser decides what is prompt text or a file: argument i is
    // one exactly when it adds a message or a file to the parse.
    const before = parseArgs(argv.slice(0, i));
    const after = parseArgs(argv.slice(0, i + 1));
    if (after.messages.length > before.messages.length || after.fileArgs.length > before.fileArgs.length) continue;
    kept.push(arg);
  }
  original.messages.length = 0;
  original.fileArgs.length = 0;
  const expected: Partial<ReturnType<typeof parseArgs>> = original;
  for (const field of ["session", "sessionId", "fork", "continue", "resume", "noSession",
    ...(restoresSessionState ? ["provider", "model", "thinking"] : []),
    ...(restoresSessionName ? ["name"] : [])]) {
    delete expected[field as keyof typeof expected];
  }
  // Removing a flag-like value can make its option swallow the next flag.
  // Check the full parse, including empty prompts, diagnostics and extension flags.
  if (!isDeepStrictEqual(parseArgs(kept), expected)) return undefined;
  return kept;
}

interface InstallFailure {
  code: number;
  output: string;
}

/** What an install run reported: how it ended, and whether the installed set actually changed. */
interface InstallOutcome { output: string; unchanged: boolean }

type NativeUpdateResult = { ok: true; output: string } | { ok: false; failure: InstallFailure };

function formatInstallFailure(failure: InstallFailure, display: string): string {
  return `Update failed while running \`${display}\` (exit ${failure.code})${failure.output ? `: ${failure.output}` : ""}`;
}

/**
 * Sentinel resolved by the ctx.ui.custom capability probe below. A host that
 * actually executes custom components (terminal TUI) resolves the custom()
 * promise with this exact in-process value; hosts that stub custom() out
 * (RPC/headless — e.g. pi-web's session host) resolve undefined without ever
 * running the factory.
 */
const CUSTOM_PROBE_SENTINEL = Symbol("pi-updater.customProbe");

/**
 * Probe whether this host actually executes ctx.ui.custom() factories.
 *
 * ctx.hasUI cannot discriminate: RPC hosts like pi-web bind a real UI context
 * (select/confirm/input/notify work) but stub custom() to a no-op that
 * resolves undefined without running the factory. That resolution contract is
 * exactly what doInstall() depends on, so probing it classifies hosts where
 * "Update now" would be a silent no-op without changing terminal behavior.
 */
async function hostCanRunCustom(ctx: ExtensionContext): Promise<boolean> {
  try {
    const result = await ctx.ui.custom<symbol | undefined>(
      (_tui, _theme, _keybindings, done) => {
        // Resolving inside the factory keeps the probe invisible: the TUI
        // host treats done-before-return as "already closed" and never
        // mounts the (empty) component.
        done(CUSTOM_PROBE_SENTINEL);
        return { render: () => [], invalidate: () => {} };
      },
    );
    return result === CUSTOM_PROBE_SENTINEL;
  } catch {
    return false;
  }
}

async function runNativeUpdate(
  pi: ExtensionAPI,
  target: UpdateTarget,
): Promise<NativeUpdateResult> {
  const previousSkip = process.env[ENV_SKIP_VERSION_CHECK];
  const previousInternalSkip = process.env[ENV_INTERNAL_SKIP];
  delete process.env[ENV_SKIP_VERSION_CHECK];
  delete process.env[ENV_INTERNAL_SKIP];

  try {
    const cmd = currentPiCommand([...UPDATE_COMMANDS[target].args]);
    const result = await pi.exec(cmd.program, cmd.args, { timeout: 300_000 });
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    // A timed-out process is killed and can report exit code 0; treat it as failure.
    if (result.killed || result.code !== 0) {
      return {
        ok: false,
        failure: {
          code: result.code,
          output: result.killed ? ["Update timed out after 5 minutes.", output].filter(Boolean).join("\n") : output,
        },
      };
    }
    return { ok: true, output };
  } finally {
    if (previousSkip === undefined) delete process.env[ENV_SKIP_VERSION_CHECK];
    else process.env[ENV_SKIP_VERSION_CHECK] = previousSkip;

    if (previousInternalSkip === undefined) delete process.env[ENV_INTERNAL_SKIP];
    else process.env[ENV_INTERNAL_SKIP] = previousInternalSkip;
  }
}

export default function (pi: ExtensionAPI) {
  // Left behind by the removed scoped model hints. This cleanup can go in a
  // later release.
  try {
    rmSync(join(getAgentDir(), "model-update-cache.json"), { force: true });
  } catch {}

  // Take over pi's built-in version notice with our update notice,
  // unless the user disabled version checks themselves.
  const suppressNativeCheck = !userSkippedVersionCheck;
  if (suppressNativeCheck) {
    process.env[ENV_SKIP_VERSION_CHECK] = "1";
    process.env[ENV_INTERNAL_SKIP] = "1";
  }

  // Once /update has run, its result replaces the automatic offer for good.
  let manualCheckStarted = false;
  let promptOpen = false;
  const promptedVersions = new Set<string>();
  let liveCheckStarted = false;
  // Host capability cannot change within a process; probe ctx.ui.custom once.
  let customSupport: Promise<boolean> | undefined;

  // Whether the host can render the TUI progress loader - not whether it can
  // install. Installing works everywhere; only the way progress is shown differs.
  function hostCanRenderLoader(ctx: ExtensionContext): Promise<boolean> {
    customSupport ??= hostCanRunCustom(ctx);
    return customSupport;
  }

  // Consume the one-shot suppression from a post-update restart. Deleting it
  // keeps it from propagating into any further restarts from this session.
  const suppressStartupCheck = isEnvSet(ENV_SUPPRESS_STARTUP_CHECK);
  delete process.env[ENV_SUPPRESS_STARTUP_CHECK];

  function canAutoRestart(ctx: ExtensionContext): boolean {
    return ctx.hasUI && !!process.stdin.isTTY && !!process.stdout.isTTY;
  }

  function restartArguments(ctx: ExtensionContext): string[] | undefined {
    if (!canAutoRestart(ctx)) return undefined;
    const sessionFile = ctx.sessionManager.getSessionFile();
    const restoresSessionState = !!sessionFile && ctx.sessionManager.buildSessionProjection().messages.length > 0;
    // A persisted name survives even when /tree moves before the first message.
    const restoresSessionName = !!sessionFile && existsSync(sessionFile);
    const flags = restartFlags(process.argv.slice(2), restoresSessionState, restoresSessionName);
    if (!flags) return undefined;
    // Put session arguments before any trailing "--". Never show arguments:
    // they can contain credentials supplied to extensions.
    return [...(sessionFile ? ["--session", sessionFile] : ["--no-session"]), ...flags];
  }

  async function restartPi(ctx: ExtensionContext, args: string[]): Promise<boolean> {
    // A removed launch folder must not leave the terminal stopped.
    let cwd: string;
    try {
      cwd = process.cwd();
    } catch {
      return false;
    }
    const cmd = currentPiCommand(args);
    const env = { ...process.env };
    if (suppressNativeCheck) {
      delete env[ENV_SKIP_VERSION_CHECK];
      delete env[ENV_INTERNAL_SKIP];
    }
    // The user just acted on an update prompt; skip the startup notice.
    env[ENV_SUPPRESS_STARTUP_CHECK] = "1";

    return ctx.ui.custom<boolean>((tui, _theme, _kb, done) => {
      tui.stop();
      const result = spawnSync(cmd.program, cmd.args, {
        // Original CLI paths are relative to the launch folder, not the resumed session.
        cwd,
        env,
        stdio: "inherit",
        windowsHide: false,
      });
      tui.start();
      tui.requestRender(true);
      done(!result.error && (result.status === null || result.status === 0));
      return { render: () => [], invalidate: () => {} };
    });
  }

  async function reloadExtensions(ctx: ExtensionContext) {
    // Command contexts (/update) can hot-reload in place — the best path.
    const maybeReload = (ctx as { reload?: () => Promise<void> }).reload;
    if (typeof maybeReload === "function") {
      ctx.ui.notify("Extensions updated. Reloading...", "info");
      await maybeReload.call(ctx);
      return;
    }
    // Event contexts (startup prompt) can't reload programmatically.
    // Restart into the same session instead — at startup this is cheap
    // and the user already consented by choosing "Update now".
    if (canAutoRestart(ctx)) {
      const ok = await restartPi(ctx, restartArguments(ctx) ?? []);
      if (ok) {
        ctx.shutdown();
        return;
      }
    }
    ctx.ui.notify("Extensions updated. Run /reload to load them.", "info");
  }

  async function doInstall(
    ctx: ExtensionContext,
    target: UpdateTarget,
    offer: UpdateOffer,
  ) {
    // Installing mid-run would restart or reload under the running agent.
    if (!ctx.isIdle()) {
      ctx.ui.notify("Pi is busy. Run /update again when the agent has finished.", "warning");
      return;
    }

    const command = UPDATE_COMMANDS[target];
    const outcome = (await hostCanRenderLoader(ctx))
      ? await installBehindLoader(ctx, target, command)
      : await installWithNotices(ctx, target, command);

    if (!outcome) return;
    return finishInstall(ctx, target, offer, outcome);
  }

  // Hosts without a TUI (pi-web and any other RPC host) cannot draw the loader.
  // The install itself needs no terminal, so run it and report through notices;
  // silence here is what made "Update now" look like a dead button.
  async function installWithNotices(
    ctx: ExtensionContext,
    target: UpdateTarget,
    command: (typeof UPDATE_COMMANDS)[UpdateTarget],
  ): Promise<InstallOutcome | undefined> {
    ctx.ui.notify(`Running ${command.display}...`, "info");
    try {
      const update = await runNativeUpdate(pi, target);
      if (!update.ok) {
        ctx.ui.notify(formatInstallFailure(update.failure, command.display), "error");
        return undefined;
      }
      return { output: update.output, unchanged: false };
    } catch (error) {
      ctx.ui.notify(
        `Update failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return undefined;
    }
  }

  async function installBehindLoader(
    ctx: ExtensionContext,
    target: UpdateTarget,
    command: (typeof UPDATE_COMMANDS)[UpdateTarget],
  ): Promise<InstallOutcome | undefined> {
    // Not cancellable: closing the loader would leave `pi update` running unseen.
    const result = await ctx.ui.custom<InstallOutcome | null>((tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, `Running ${command.display}...`, {
        cancellable: false,
      });

      // `pi update` exits 0 even when stale npm metadata kept every package at
      // its old version, so compare what is installed before and after. This
      // runs under the loader, which keeps the user from starting a run.
      const install = async () => {
        const before = target === "extensions" ? await readPackageRevisions(pi, ctx) : undefined;
        const update = await runNativeUpdate(pi, target);
        const unchanged =
          update.ok && before !== undefined && before === (await readPackageRevisions(pi, ctx));
        return { update, unchanged };
      };

      install()
        .then(({ update, unchanged }) => {
          if (update.ok) {
            done({ output: update.output, unchanged });
          } else {
            ctx.ui.notify(formatInstallFailure(update.failure, command.display), "error");
            done(null);
          }
        })
        .catch((error) => {
          ctx.ui.notify(
            `Update failed: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          done(null);
        });

        return loader;
    });
    return result ?? undefined;
  }

  async function finishInstall(
    ctx: ExtensionContext,
    target: UpdateTarget,
    offer: UpdateOffer,
    result: InstallOutcome,
  ) {
    if (target === "extensions") {
      // Reloading after an update that installed nothing would only bring the
      // same prompt back.
      if (result.unchanged) {
        ctx.ui.notify(
          [`Extensions were not updated: ${offer.extensions.join(", ")}`, result.output]
            .filter(Boolean)
            .join("\n\n"),
          "warning",
        );
        return;
      }
      await reloadExtensions(ctx);
      return;
    }

    const latest = offer.piLatest ?? "latest";
    const restartTip = ctx.sessionManager.getSessionFile()
      ? "Tip: run `pi -c` to continue this session."
      : "Tip: run `pi --no-session` to continue without a saved session.";

    if (!canAutoRestart(ctx)) {
      // A long-lived host (pi-web's session daemon) keeps running the old
      // version until IT is restarted — the owner reported that clicking
      // the prompt "did nothing" because the notice said "restart pi" while the running
      // daemon never changed. Name the actual restart the host needs.
      if (!hostCanRenderLoader(ctx)) {
        ctx.ui.notify(
          `Updated to ${latest}! The running session daemon still has the old version — restart the session daemon to run it (restart the web/API process first). Until then this prompt stays suppressed for ${latest}.`,
          "info",
        );
        return;
      }
      ctx.ui.notify(
        `Updated to ${latest}! Please restart pi.\n${restartTip}`,
        "info",
      );
      return;
    }

    // Restarting relaunches process.argv[1], so only do it when that now
    // leads to a different version than the one running.
    const updatedInPlace = (readRestartPiVersion() ?? VERSION) !== VERSION;

    const args = updatedInPlace ? restartArguments(ctx) : undefined;
    if (!args) {
      ctx.ui.notify(
        `Updated to ${latest}! Please restart pi.\n${restartTip}`,
        "info",
      );
      return;
    }

    // No confirmation: choosing the update option was the consent, and the
    // restart relaunches straight into the current session.
    const ok = await restartPi(ctx, args);
    if (ok) {
      ctx.shutdown();
      return;
    }

    ctx.ui.notify(
      `Updated to ${latest}! Auto-restart failed. Please restart pi manually.\n${restartTip}`,
      "error",
    );
  }

  async function doInstallFromPrompt(
    ctx: ExtensionContext,
    target: UpdateTarget,
    offer: UpdateOffer,
  ): Promise<void> {
    await doInstall(ctx, target, offer);
  }

  async function showUpdatePrompt(
    ctx: ExtensionContext,
    offer: UpdateOffer,
    install: (target: UpdateTarget) => Promise<void> = (target) => doInstallFromPrompt(ctx, target, offer),
    decisions: UpdateDecisions = RECORDED_DECISIONS,
  ) {
    const { piLatest, extensions } = offer;
    const extList = extensions.join(", ");

    if (piLatest && extensions.length > 0) {
      const updateAll = "Update all";
      const updatePi = "Update pi only";
      const updateExtensions = "Update extensions only";
      // No "Ignore pi X" here: dismissing a version while also deciding about
      // extensions is ambiguous. Version dismissal lives in the pi-only prompt.
      const choice = await ctx.ui.select(
        `Update pi ${VERSION} → ${piLatest} · extensions: ${extList}`,
        [updateAll, updatePi, updateExtensions, "Skip"],
      );

      if (!choice || choice === "Skip") {
        // Closing without an answer counts as the answer "not this version"
        // (the owner's ruling): an offer that returns because the dialog was
        // cancelled is the same nag by another name.
        decisions.dismissVersion(piLatest);
        decisions.settleExtensionSet(extensions);
        // Skip on the combined prompt dismisses the pi version too: the owner
        // reported the prompt returning for an already-acted version, and a
        // dismissal that only sometimes dismisses is how that read from the
        // user's seat. The extension set settles as well - a skip answered in
        // one session answers it for the machine.
        return;
      }
      // Acting on the offer records the version: the install lands on disk
      // but a long-lived host keeps running the old version until restart,
      // and an unrecorded action is what made the prompt return.
      decisions.actOnVersion(piLatest);
      if (choice === updateAll || choice === updateExtensions) decisions.settleExtensionSet(extensions);
      if (!choice || choice === "Skip") return;
      if (choice === updateAll) return install("all");
      if (choice === updatePi) return install("self");
      if (choice === updateExtensions) return install("extensions");
      return;
    }

    if (piLatest) {
      const updateAction = "Update now";
      const ignorePiVersion = `Ignore ${piLatest}`;
      const choice = await ctx.ui.select(`Update ${VERSION} → ${piLatest}`, [
        updateAction,
        "Skip",
        ignorePiVersion,
      ]);

      if (!choice || choice === "Skip") {
        decisions.dismissVersion(piLatest);
        return;
      }
      if (choice === ignorePiVersion) {
        decisions.dismissVersion(piLatest);
        return;
      }
      if (choice !== updateAction) return;
      await install("self");
      return;
    }

    if (extensions.length > 0) {
      const updateAction = "Update now";
      const choice = await ctx.ui.select(`Extension updates available: ${extList}`, [
        updateAction,
        "Skip",
      ]);
      // Both answers settle the set machine-wide; an unanswered (dismissed
      // without an answer) prompt does not, so a genuinely ignored dialog
      // returns once but an ANSWERED one never nags another session.
      decisions.settleExtensionSet(extensions);
      if (choice === updateAction) await install("extensions");
    }
  }

  function canAutoPromptVersion(latest: string): boolean {
    return shouldPromptForVersion({ latest, runningVersion: VERSION, cache: readCache(), prompted: promptedVersions });
  }

  async function maybeShowAutoPrompt(
    ctx: ExtensionContext,
    latest: string | undefined,
    extensions: string[],
  ) {
    // The checks that lead here run after session_start returns, so this ctx
    // may be stale by the time they resolve - the session it belonged to was
    // replaced or reloaded. Every ctx member, including the hasUI getter,
    // throws on a stale ctx, and an unhandled throw here has killed a host
    // daemon serving other sessions. A stale ctx means the session this
    // prompt was meant for is gone; the right response is silence.
    let hasUi: boolean;
    try {
      hasUi = ctx.hasUI;
    } catch {
      return;
    }
    if (!hasUi) return;
    if (promptOpen) return;
    // A host that does not execute custom components is a surface with its own
    // shell - pi-web - and that shell shows the offer itself, once per machine,
    // outside any one conversation. Prompting here as well put the same offer
    // in every session's transcript. Refreshing the cache above is what that
    // shell reads, so the check still earns its keep.
    if (!(await hostCanRunCustom(ctx))) return;

    const piLatest = latest && canAutoPromptVersion(latest) ? latest : undefined;
    const openExtensions = unsettledExtensions(extensions);
    if (!piLatest && openExtensions.length === 0) return;

    promptOpen = true;
    if (piLatest) { promptedVersions.add(piLatest); notePromptedVersion(piLatest); }
    try {
      await showUpdatePrompt(ctx, { piLatest, extensions: openExtensions });
    } finally {
      promptOpen = false;
    }
  }

  function runAutoChecks(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (shouldSkipAutoChecks()) return;
    if (liveCheckStarted) return;
    liveCheckStarted = true;

    // Check once per process and report both results without taking input.
    void Promise.all([
      refreshLatestVersionInCache().catch(() => undefined),
      checkForExtensionUpdates(ctx).catch(() => [] as string[]),
    ])
      .then(([latest, extensions]) => {
        if (manualCheckStarted || !ctx.hasUI) return;
        const cache = readCache();
        const version = latest ?? cache?.latestVersion;
        const updates: string[] = [];
        if (version && isNewer(version, VERSION) && cache?.dismissedVersion !== version) {
          updates.push(`pi ${VERSION} → ${version}`);
        }
        if (extensions.length) updates.push(`extensions: ${extensions.join(", ")}`);
        if (updates.length) ctx.ui.notify(`Updates available: ${updates.join(" · ")}. Run /update to install.`, "info");
      })
      .catch(() => {});
  }

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "reload" || event.reason === "fork") return;
    // One-shot suppression applies only to the startup right after a
    // post-update restart, never to later new/resume session starts.
    if (suppressStartupCheck && event.reason === "startup") return;
    runAutoChecks(ctx);
  });

  pi.registerCommand("update", {
    description: "Check for pi updates and install with pi's native updater",
    handler: async (rawArgs, ctx) => {
      // The demo uses the real presentation with fixture data and an inert installer.
      if (rawArgs?.trim() === "--test") {
        if (!ctx.hasUI || ctx.mode !== "tui") {
          ctx.ui.notify("The update demo requires an interactive terminal.", "warning");
          return;
        }
        ctx.ui.notify("Demo only. Nothing will be changed.", "info");
        await showUpdatePrompt(ctx, {
          piLatest: "99.0.0",
          extensions: ["example-tools", "example-prompts"],
        }, async (target) => {
          const completed = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
            const loader = new BorderedLoader(tui, theme, `Demo: ${UPDATE_COMMANDS[target].display}...`);
            const timer = setTimeout(() => done(true), 1500);
            loader.onAbort = () => {
              clearTimeout(timer);
              done(false);
            };
            return loader;
          });
          const status = completed ? "Demo complete. Nothing changed." : "Demo cancelled. Nothing changed.";
          ctx.ui.notify(status, "info");
        }, UNRECORDED_DECISIONS);
        return;
      }

      if (isOffline()) {
        ctx.ui.notify(
          "PI_OFFLINE is set. Disable it to check for updates.",
          "warning",
        );
        return;
      }

      // Avoid a duplicate notice if the automatic check is still running.
      manualCheckStarted = true;

      const result = await ctx.ui.custom<{
        latest: string | undefined;
        extensions: string[];
      } | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(
          tui,
          theme,
          "Checking for updates...",
        );
        loader.onAbort = () => done(null);
        Promise.all([
          fetchLatestVersion().catch(() => undefined),
          checkForExtensionUpdates(ctx).catch(() => [] as string[]),
        ])
          .then(([latest, extensions]) => done({ latest, extensions }))
          .catch(() => done(null));
        return loader;
      });

      if (!result || (!result.latest && result.extensions.length === 0)) {
        ctx.ui.notify("Could not reach Pi update service.", "error");
        return;
      }

      const { latest, extensions } = result;
      if (latest) saveLatestToCache(latest);

      const piLatest = latest && isNewer(latest, VERSION) ? latest : undefined;

      if (!piLatest && extensions.length === 0) {
        ctx.ui.notify(`pi ${VERSION} · extensions up to date`, "info");
        return;
      }

      if (piLatest) { promptedVersions.add(piLatest); notePromptedVersion(piLatest); }
      const offer = { piLatest, extensions };
      await showUpdatePrompt(ctx, offer);
    },
  });
}
