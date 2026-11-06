'use strict';
// Dependency manifests: a package that changes one needs the whole repo, because worktrees borrow
// dependency directories through symlinks. Shared by bin/h-plans (the `runs alone` note) and
// lib/registry.js conflicts (the manifest rule of admission and extend).
const path = require('path');
// A plan that changes one of these runs with nothing else in flight.
const ALONE = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pyproject.toml',
  'poetry.lock', 'uv.lock', 'Pipfile', 'Pipfile.lock', 'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock',
  'Gemfile', 'Gemfile.lock'];
const aloneFile = f => ALONE.includes(path.basename(f)) || /^requirements[\w.-]*\.txt$/.test(path.basename(f));
module.exports = { ALONE, aloneFile };
