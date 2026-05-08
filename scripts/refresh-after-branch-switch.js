#!/usr/bin/env node

const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const checkoutType = process.argv[4];

if (checkoutType !== '1') {
  process.exit(0);
}

const repoRoot = path.resolve(__dirname, '..');
const ports = [3000, 4200];
const processMatchers = [
  /backend[\\/]+server\.js/i,
  /@angular[\\/]+cli[\\/]+bin[\\/]+ng\.js.*\bserve\b/i,
  /\bng(?:\.cmd)?\s+serve\b/i,
];

console.log('[post-checkout] Branch changed; refreshing npm feed dependencies.');

for (const processInfo of findDevServerProcesses(ports)) {
  const commandLine = processInfo.commandLine || '';
  const cwd = processInfo.cwd || '';
  const belongsToRepo =
    cwd.startsWith(repoRoot) ||
    commandLine.includes(repoRoot) ||
    processMatchers.some((matcher) => matcher.test(commandLine));

  if (!belongsToRepo) {
    console.log(
      `[post-checkout] Leaving PID ${processInfo.pid} on port ${processInfo.port}; it does not look like this app.`,
    );
    continue;
  }

  try {
    process.kill(processInfo.pid);
    console.log(`[post-checkout] Stopped PID ${processInfo.pid} listening on port ${processInfo.port}.`);
  } catch (error) {
    console.warn(`[post-checkout] Could not stop PID ${processInfo.pid}: ${error.message}`);
  }
}

const install = spawnSync('npm', ['--prefix', 'frontend', 'install'], {
  cwd: repoRoot,
  shell: process.platform === 'win32',
  stdio: 'inherit',
});

if (install.status !== 0) {
  console.error('[post-checkout] npm install failed; rerun npm --prefix frontend install after fixing the issue.');
  process.exit(install.status || 1);
}

console.log('[post-checkout] Frontend dependencies refreshed.');

function findDevServerProcesses(targetPorts) {
  return process.platform === 'win32' ? findWindowsProcesses(targetPorts) : findUnixProcesses(targetPorts);
}

function findWindowsProcesses(targetPorts) {
  const script = `
$ports = @(${targetPorts.join(',')})
$items = foreach ($port in $ports) {
  Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
    ForEach-Object {
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue
      [PSCustomObject]@{
        port = $port
        pid = $_.OwningProcess
        commandLine = if ($proc) { $proc.CommandLine } else { "" }
        cwd = if ($proc) { $proc.ExecutablePath } else { "" }
      }
    }
}
$items | ConvertTo-Json -Compress
`;

  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
    }).trim();

    if (!output) return [];
    const parsed = JSON.parse(output);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(normalizeProcessInfo);
  } catch (error) {
    console.warn(`[post-checkout] Could not inspect listening ports: ${error.message}`);
    return [];
  }
}

function findUnixProcesses(targetPorts) {
  const processes = [];

  for (const port of targetPorts) {
    const lsof = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
    if (lsof.status !== 0 || !lsof.stdout.trim()) continue;

    for (const pidText of lsof.stdout.trim().split(/\s+/)) {
      const pid = Number(pidText);
      if (!Number.isInteger(pid)) continue;

      const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
      processes.push(normalizeProcessInfo({ port, pid, commandLine: command.stdout.trim(), cwd: '' }));
    }
  }

  return processes;
}

function normalizeProcessInfo(processInfo) {
  return {
    port: Number(processInfo.port),
    pid: Number(processInfo.pid),
    commandLine: String(processInfo.commandLine || ''),
    cwd: String(processInfo.cwd || ''),
  };
}
