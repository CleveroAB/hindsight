#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentMode = process.env.HINDSIGHT_AGENT === 'codex' ? 'codex' : 'mock';
const agentImage = process.env.HINDSIGHT_DOCKER_IMAGE || 'hindsight-agent:latest';

function fail(message) {
  console.error(`\n[dev] ${message}`);
  process.exit(1);
}

if (agentMode === 'codex') {
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
const next = spawn(nextExecutable, ['dev', ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: process.env,
  stdio: 'inherit',
});

next.on('error', (error) => {
  fail(`Could not start Next.js: ${error.message}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!next.killed) next.kill(signal);
  });
}

next.on('exit', (code, signal) => {
  if (signal) {
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
  } else {
    process.exitCode = code ?? 1;
  }
});
