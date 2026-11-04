"""Check distributable sources and local Markdown links without game data."""
import os
from pathlib import Path
import re
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
GENERATED = {'node_modules', 'dist', '.test-work', '.npm-cache', '__pycache__', '.git'}


def inside(path):
    try:
        path.resolve().relative_to(ROOT)
        return True
    except ValueError:
        return False


def main():
    errors, count = [], 0
    for directory, dirs, files in os.walk(ROOT):
        for name in dirs + files:
            p = Path(directory) / name
            if p.is_symlink() and not inside(p):
                errors.append(f'External symlink: {p.relative_to(ROOT)}')
        dirs[:] = [d for d in dirs if d not in GENERATED]
        for name in files:
            p = Path(directory) / name
            rel = p.relative_to(ROOT)
            if name == '.DS_Store':
                continue
            count += 1
            if any(part in {'work', 'releases', 'jobs', 'adapters'} for part in rel.parts) or '.lg' in p.suffixes:
                errors.append(f'Game data in source package: {rel}')
            if p.suffix not in {'.md', '.ts', '.mjs', '.py', '.rb', '.json'}:
                continue
            text = p.read_text(encoding='utf-8')
            if re.search(r'/(?:Users|home)/[A-Za-z0-9_-]+/', text):
                errors.append(f'Machine-specific path: {rel}')
            if p.suffix == '.md':
                for target in re.findall(r'\]\(([^)]+)\)', text):
                    if re.match(r'^(?:https?://|#)', target):
                        continue
                    local = unquote(target.split('#')[0])
                    linked = p.parent / local
                    if not inside(linked) or not linked.exists():
                        errors.append(f'Broken or external local link: {rel} -> {target}')
    if errors:
        raise SystemExit('\n'.join(errors))
    print(f'Package check passed: {count} source files; local links stay inside the package.')


if __name__ == '__main__':
    main()
