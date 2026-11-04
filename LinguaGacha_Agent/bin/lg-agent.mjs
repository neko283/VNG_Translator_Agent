#!/usr/bin/env node
const [major, minor, patch] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && (minor < 22 || (minor === 22 && patch < 1)))) {
  console.error('Node.js >=24.22.1 required. Activate your installed Node runtime; this package does not download Node.');
  process.exit(1);
}
await import('../dist/cli.mjs');
