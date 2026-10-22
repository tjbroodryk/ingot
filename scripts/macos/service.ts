/**
 * `bun run service <command>` — ingot as a macOS login service.
 *
 * Three LaunchAgents, all pointed at this checkout:
 *
 *   dev.ingotdb          runs `run.sh` at login and again whenever it exits.
 *                        The API is under `bun --watch` and the dashboard under
 *                        `next dev`, so an edit, a branch switch or a pull is
 *                        live without touching the service.
 *   dev.ingotdb.reload   restarts dev.ingotdb when bun.lock or apps/ingot/.env
 *                        changes — the two things `--watch` can't follow, since
 *                        a new dependency needs an install and the env is read
 *                        once at boot.
 *   dev.ingotdb.menubar  the status item: an ingot in the menu bar, lit while
 *                        the API answers, with start / stop / restart under it.
 *
 * macOS only. Everything goes through launchctl and lives under ~/Library;
 * `uninstall` removes all of it.
 */
import { mkdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const LABEL = 'dev.ingotdb';
const RELOAD_LABEL = `${LABEL}.reload`;
const MENU_LABEL = `${LABEL}.menubar`;

const ROOT = resolve(dirname(Bun.fileURLToPath(import.meta.url)), '..', '..');
const RUN = join(ROOT, 'scripts/macos/run.sh');
const SWIFT = join(ROOT, 'scripts/macos/IngotMenu.swift');

const AGENTS = join(homedir(), 'Library/LaunchAgents');
const PLIST = join(AGENTS, `${LABEL}.plist`);
const RELOAD_PLIST = join(AGENTS, `${RELOAD_LABEL}.plist`);
const MENU_PLIST = join(AGENTS, `${MENU_LABEL}.plist`);
const LOG = join(homedir(), 'Library/Logs/ingot/ingot.log');
const MENU_APP = join(homedir(), 'Applications/Ingot Menu.app');
const MENU_BINARY = join(MENU_APP, 'Contents/MacOS/IngotMenu');

const HEALTH = 'http://127.0.0.1:3002/api/health';

const domain = `gui/${process.getuid?.() ?? 501}`;

const usage = `bun run service <command>

  install     start ingot at login, keep it running, add the menu bar item
  uninstall   remove all of it; the checkout and its data are left alone
  start       load the service again after a stop
  stop        stop it until \`start\` or the next login
  restart     restart it now (it restarts itself on bun.lock and .env changes)
  status      is it loaded, and is the API answering
  logs        follow ${LOG}
  menu        rebuild and relaunch the menu bar app only
`;

async function main(): Promise<number> {
  if (process.platform !== 'darwin') {
    process.stderr.write('The service is macOS-only (launchd). Run `bun run dev` instead.\n');
    return 1;
  }

  switch (process.argv[2]) {
    case 'install':
      return install();
    case 'uninstall':
      return uninstall();
    case 'start':
      await launchctl(['bootstrap', domain, PLIST]);
      process.stdout.write('Starting. The menu bar item lights up once the API answers.\n');
      return 0;
    case 'stop':
      await launchctl(['bootout', `${domain}/${LABEL}`], true);
      process.stdout.write('Stopped until `bun run service start` or the next login.\n');
      return 0;
    case 'restart':
      await launchctl(['kickstart', '-k', `${domain}/${LABEL}`]);
      process.stdout.write('Restarting.\n');
      return 0;
    case 'status':
      return status();
    case 'logs':
      return logs();
    case 'menu':
      await installMenu();
      return 0;
    default:
      process.stderr.write(usage);
      return 1;
  }
}

async function install(): Promise<number> {
  for (const needed of [join(ROOT, 'apps/ingot/.env'), join(ROOT, 'node_modules')]) {
    if (!(await exists(needed))) {
      process.stderr.write(
        `${needed} is missing. The service runs this checkout as \`bun run dev\` would, so:\n` +
          '  bun install\n  cp apps/ingot/.env.example apps/ingot/.env   # and fill it in\n',
      );
      return 1;
    }
  }

  await mkdir(AGENTS, { recursive: true });
  await mkdir(dirname(LOG), { recursive: true });

  step(`Installing ${LABEL}`);
  await replaceAgent(LABEL, PLIST, servicePlist());

  step(`Installing ${RELOAD_LABEL}`);
  await replaceAgent(RELOAD_LABEL, RELOAD_PLIST, reloadPlist());

  step(`Building ${MENU_APP}`);
  await installMenu();

  process.stdout.write(
    `\nIngot starts at login and stays up. Edits in ${ROOT} are picked up live.\n` +
      `  API        http://localhost:3002/api/v1\n` +
      `  dashboard  http://localhost:5174\n` +
      `  logs       bun run service logs\n` +
      `  status     bun run service status, or the menu bar\n`,
  );
  return 0;
}

async function uninstall(): Promise<number> {
  for (const [label, plist] of [
    [MENU_LABEL, MENU_PLIST],
    [RELOAD_LABEL, RELOAD_PLIST],
    [LABEL, PLIST],
  ] as const) {
    await launchctl(['bootout', `${domain}/${label}`], true);
    await rm(plist, { force: true });
  }
  await rm(MENU_APP, { recursive: true, force: true });
  process.stdout.write(`Removed. Postgres is still up in Docker; \`bun run db:down\` stops it.\n`);
  return 0;
}

async function status(): Promise<number> {
  const state = await agentState(LABEL);
  const reload = await agentState(RELOAD_LABEL);
  const menu = await agentState(MENU_LABEL);
  let api: string;
  try {
    const response = await fetch(HEALTH, { signal: AbortSignal.timeout(1500) });
    api = response.ok ? `answering at ${HEALTH}` : `HTTP ${response.status} from ${HEALTH}`;
  } catch {
    api = 'not answering';
  }
  process.stdout.write(
    `${LABEL}: ${state ?? 'not loaded'}\n` +
      `${RELOAD_LABEL}: ${reload ?? 'not loaded'}\n` +
      `${MENU_LABEL}: ${menu ?? 'not loaded'}\n` +
      `API: ${api}\n`,
  );
  return 0;
}

async function logs(): Promise<number> {
  if (!(await exists(LOG))) {
    process.stderr.write(`No log at ${LOG}. Is the service installed?\n`);
    return 1;
  }
  const child = Bun.spawn(['tail', '-n', '200', '-f', LOG], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return child.exited;
}

/**
 * A LaunchAgent that runs the stack at login and again if it dies.
 *
 * `KeepAlive` rather than only `RunAtLoad`: run.sh exits when the API or the
 * dashboard does, and coming back is the point. `ThrottleInterval` keeps a
 * stack that fails at once — Docker not installed, a bad .env — from spinning.
 * `Standard` rather than `Background` because queries from an agent are
 * waited on; a background job's CPU and I/O are deprioritised.
 */
function servicePlist(): string {
  return plist({
    Label: LABEL,
    ProgramArguments: ['/bin/bash', RUN],
    WorkingDirectory: ROOT,
    EnvironmentVariables: { HOME: homedir(), PATH: process.env.PATH ?? '/usr/bin:/bin' },
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 30,
    ProcessType: 'Standard',
    StandardOutPath: LOG,
    StandardErrorPath: LOG,
  });
}

/**
 * Kicks the service when a file `bun --watch` can't follow changes. launchd
 * starts this job on a change; it is not kept alive, so it runs once and
 * exits. run.sh does the `bun install` on the way back up.
 */
function reloadPlist(): string {
  return plist({
    Label: RELOAD_LABEL,
    ProgramArguments: ['/bin/launchctl', 'kickstart', '-k', `${domain}/${LABEL}`],
    WatchPaths: [join(ROOT, 'bun.lock'), join(ROOT, 'apps/ingot/.env')],
    ThrottleInterval: 10,
    ProcessType: 'Background',
  });
}

/** Started at login, in the GUI session only, and left alone once quit from its menu. */
function menuPlist(): string {
  return plist({
    Label: MENU_LABEL,
    ProgramArguments: [MENU_BINARY],
    RunAtLoad: true,
    LimitLoadToSessionType: 'Aqua',
    ProcessType: 'Interactive',
  });
}

/** `LSUIElement`: a menu bar item and nothing else — no Dock icon, no app menu. */
function infoPlist(): string {
  return plist({
    CFBundleIdentifier: MENU_LABEL,
    CFBundleName: 'Ingot Menu',
    CFBundleExecutable: 'IngotMenu',
    CFBundlePackageType: 'APPL',
    LSUIElement: true,
  });
}

async function installMenu(): Promise<void> {
  await mkdir(dirname(MENU_BINARY), { recursive: true });
  await Bun.write(join(MENU_APP, 'Contents/Info.plist'), infoPlist());
  await compile(SWIFT, MENU_BINARY);
  await replaceAgent(MENU_LABEL, MENU_PLIST, menuPlist());
}

/** A loaded agent keeps the plist it was loaded with until it is booted out. */
async function replaceAgent(label: string, path: string, contents: string): Promise<void> {
  await launchctl(['bootout', `${domain}/${label}`], true);
  await Bun.write(path, contents);
  await launchctl(['bootstrap', domain, path]);
}

/** `launchctl print`'s state and pid lines, or null when the agent is not loaded. */
async function agentState(label: string): Promise<string | null> {
  const child = Bun.spawn(['launchctl', 'print', `${domain}/${label}`], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const out = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) return null;
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(state|pid|last exit code) =/.test(line))
    .join(', ');
}

async function launchctl(args: readonly string[], tolerate = false): Promise<void> {
  const child = Bun.spawn(['launchctl', ...args], { stdout: 'ignore', stderr: 'pipe' });
  const code = await child.exited;
  if (code !== 0 && !tolerate) {
    const why = (await new Response(child.stderr).text()).trim();
    throw new Error(`launchctl ${args[0]} failed (${code}): ${why}`);
  }
}

/**
 * `swiftc`, from the Command Line Tools or Xcode. Some CLT releases ship two
 * module maps that both define `SwiftBridging` and every AppKit build fails on
 * it; the usual fix is deleting one with sudo. This hides it from this one
 * build instead, through a VFS overlay, and only when that is the error.
 */
async function compile(source: string, binary: string): Promise<void> {
  const args = ['swiftc', '-swift-version', '5', '-O', source, '-o', binary];
  const first = await swiftc(args);
  if (first.code === 0) return;

  const duplicate = /redefinition of module 'SwiftBridging'/.test(first.stderr);
  const map = /(\/\S+\/usr\/include\/swift)\/module\.modulemap/.exec(first.stderr)?.[1];
  if (!duplicate || !map) throw new Error(`swiftc failed:\n${first.stderr.trim()}`);

  const scratch = join(ROOT, 'node_modules/.cache/ingot-menu');
  await mkdir(scratch, { recursive: true });
  const empty = join(scratch, 'empty.modulemap');
  const overlay = join(scratch, 'overlay.yaml');
  await Bun.write(empty, '');
  await Bun.write(
    overlay,
    JSON.stringify({
      version: 0,
      'case-sensitive': 'false',
      roots: [
        {
          type: 'directory',
          name: map,
          contents: [{ type: 'file', name: 'module.modulemap', 'external-contents': empty }],
        },
      ],
    }),
  );

  const second = await swiftc([...args, '-vfsoverlay', overlay]);
  if (second.code !== 0) throw new Error(`swiftc failed:\n${second.stderr.trim()}`);
}

async function swiftc(args: readonly string[]): Promise<{ code: number; stderr: string }> {
  try {
    const child = Bun.spawn([...args], { stdout: 'ignore', stderr: 'pipe' });
    const stderr = await new Response(child.stderr).text();
    return { code: await child.exited, stderr };
  } catch {
    throw new Error('swiftc is not installed. `xcode-select --install` provides it.');
  }
}

type Value = string | number | boolean | readonly Value[] | { readonly [key: string]: Value };

function plist(dict: { readonly [key: string]: Value }): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0">\n${node(dict, '')}</plist>\n`
  );
}

function node(value: Value, indent: string): string {
  const inner = `${indent}  `;
  if (typeof value === 'string') return `${indent}<string>${escapeXml(value)}</string>\n`;
  if (typeof value === 'number') return `${indent}<integer>${value}</integer>\n`;
  if (typeof value === 'boolean') return `${indent}<${value}/>\n`;
  if (Array.isArray(value)) {
    return `${indent}<array>\n${value.map((v) => node(v, inner)).join('')}${indent}</array>\n`;
  }
  const entries = Object.entries(value as { readonly [key: string]: Value });
  return (
    `${indent}<dict>\n` +
    entries.map(([k, v]) => `${inner}<key>${escapeXml(k)}</key>\n${node(v, inner)}`).join('') +
    `${indent}</dict>\n`
  );
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function step(what: string): void {
  process.stdout.write(`==> ${what}\n`);
}

process.exitCode = await main();
