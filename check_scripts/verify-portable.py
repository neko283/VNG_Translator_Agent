"""Build and test a clean source copy, with no adjacent projects or game data."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED = ('node_modules', 'dist', '.test-work', '.npm-cache', '__pycache__',
            '*.pyc', '.DS_Store', '.git')


def main():
    subprocess.run([sys.executable, '-B', str(ROOT / 'check_scripts/check-package.py')], check=True)
    npm = shutil.which('npm')
    if not npm:
        raise SystemExit('Install and activate Node.js >=24.22.1 with npm first.')
    with tempfile.TemporaryDirectory(prefix='vng-portable-') as temporary:
        destination = Path(temporary) / 'VNG_Translator_Agent'
        shutil.copytree(ROOT, destination, ignore=shutil.ignore_patterns(*EXCLUDED))
        env = dict(os.environ, PYTHON=sys.executable)
        env.pop('NODE_PATH', None)
        env.pop('NODE_OPTIONS', None)
        for task in ['setup', 'verify', 'doctor']:
            subprocess.run([npm, 'run', task], cwd=destination, env=env, check=True)
        print('Portable verification passed from a clean temporary source copy.')


if __name__ == '__main__':
    main()
