import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const reportPath = resolve(root, 'audit-reports', 'latest.json');
const watch = process.argv.includes('--watch');
const intervalSeconds = Number(process.argv.find((arg) => arg.startsWith('--interval='))?.split('=')[1] ?? 300);

function run(command, args) {
  const startedAt = new Date().toISOString();
  const commandArgs = [command, ...args].join(' ');
  const executable = process.platform === 'win32' ? process.env.ComSpec : command;
  const spawnArgs = process.platform === 'win32' ? ['/d', '/s', '/c', commandArgs] : args;
  const result = spawnSync(executable, spawnArgs, {
    cwd: root,
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
  });
  return {
    command: [command, ...args].join(' '),
    startedAt,
    finishedAt: new Date().toISOString(),
    passed: result.status === 0,
    exitCode: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-12000),
  };
}

function runAudit() {
  const checks = [
    run('npm', ['run', 'typecheck']),
    run('npm', ['run', 'lint']),
    run('npm', ['test', '--', '--runInBand']),
    run('npx', ['expo', 'export', '--platform', 'web', '--output-dir', '.expo-audit-export']),
  ];
  rmSync(resolve(root, '.expo-audit-export'), { recursive: true, force: true });
  const report = {
    generatedAt: new Date().toISOString(),
    scope: 'Local source, typecheck, lint, Jest, and web export checks.',
    evidenceLimits: [
      'This report does not prove physical-device behavior.',
      'This report does not prove offline cold start or production builds.',
      'Browser interaction and visual review require a separate live-browser run.',
    ],
    checks,
    passed: checks.every((check) => check.passed),
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${report.passed ? 'PASS' : 'FAIL'} ${reportPath}\n`);
  return report.passed;
}

do {
  const passed = runAudit();
  if (!watch) process.exitCode = passed ? 0 : 1;
  if (watch) {
    const delay = Math.max(30, intervalSeconds) * 1000;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  }
} while (watch);
