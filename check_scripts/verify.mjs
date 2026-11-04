import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run(python, ['-B', 'check_scripts/check-package.py']);
// npm_execpath avoids platform-specific npm.cmd shell invocation.
if (!process.env.npm_execpath) throw new Error('Run this script with npm run verify.');
run(process.execPath, [process.env.npm_execpath, 'run', 'verify'], `${root}/LinguaGacha_Agent`);
run(python, ['-B', '-m', 'unittest', 'discover', '-s', 'Game_Engine_Tools/Artemis/tools', '-p', 'test_*.py', '-v']);
