#!/usr/bin/env bun

// Launcher for the two processes Hindsight runs as:
//
//   the API server   `bun server/index.ts` — sessions, runs, SSE, sharing,
//                    signals. The phone app talks to it directly.
//   the web UI       Next.js, which forwards /api/* and /share/* to the API.
//
//   bun scripts/dev.mjs          → API + `next dev`
//   bun scripts/dev.mjs start    → API + `next start` (after `bun run build`)
//
// Extra arguments go to Next (`bun run dev -- --port 4000`). In Codex mode the
// agent image is (re)built first; unchanged layers come from Docker's cache.

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const nextCommand = args[0] === 'start' ? 'start' : 'dev';
const nextArgs = args[0] === 'start' ? args.slice(1) : args;
const agentMode = process.env.HINDSIGHT_AGENT === 'codex' ? 'codex' : 'mock';
const agentImage = process.env.HINDSIGHT_DOCKER_IMAGE || 'hindsight-agent:latest';

function fail(message) {
  console.error(`\n[dev] ${message}`);
  process.exit(1);
}

if (agentMode === 'codex' && nextCommand === 'dev') {
  console.log('[dev] Codex agent enabled; checking Docker…');
  const docker = spawnSync('docker', ['info'], { cwd: projectRoot, stdio: 'ignore' });

  if (docker.error?.code === 'ENOENT') {
    fail('Docker CLI was not found. Install Docker, start it, and run `bun run dev` again.');
  }
  if (docker.status !== 0) {
    fail('Docker is installed, but its daemon is unavailable. Start Docker and run `bun run dev` again.');
  }

  console.log(`[dev] Building local agent image ${agentImage} (cached when unchanged)…`);
  const build = spawnSync(
    'docker',
    ['build', '--tag', agentImage, path.join(projectRoot, 'docker')],
    { cwd: projectRoot, stdio: 'inherit' },
  );

  if (build.error) {
    fail(`Could not start the agent image build: ${build.error.message}`);
  }
  if (build.status !== 0) {
    fail(`Agent image build failed with exit code ${build.status ?? 'unknown'}.`);
  }
}

const nextExecutable = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'next.cmd' : 'next',
);

const children = [
  { name: 'API server', proc: spawn(process.execPath, ['server/index.ts'], { cwd: projectRoot, env: process.env, stdio: 'inherit' }) },
  { name: 'Next.js', proc: spawn(nextExecutable, [nextCommand, ...nextArgs], { cwd: projectRoot, env: process.env, stdio: 'inherit' }) },
];

// The two live and die together: the UI is useless without the API, and an
// API left behind would keep the port (and any agent runs) alive unnoticed.
let stopping = false;
function stopAll(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const { proc } of children) {
    if (proc.exitCode === null && !proc.killed) proc.kill(signal);
  }
}

for (const { name, proc } of children) {
  proc.on('error', (error) => {
    stopAll();
    fail(`Could not start ${name}: ${error.message}`);
  });
  proc.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`\n[dev] ${name} exited (${signal ?? `code ${code}`}); stopping.`);
      process.exitCode = signal ? (signal === 'SIGINT' ? 130 : 143) : (code ?? 1);
    }
    stopAll();
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    stopAll(signal);
  });
}
