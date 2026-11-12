#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function commitExists(sha) {
  if (!sha || /^0+$/.test(sha)) return false;
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getChangedFiles() {
  const override = process.env.CI_CHANGED_FILES;
  if (override !== undefined) {
    return {
      forceFull: false,
      files: override
        .split(/\r?\n|,/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }

  const event = process.env.GITHUB_EVENT_NAME ?? '';
  if (event === 'pull_request') {
    const baseSha = process.env.PR_BASE_SHA ?? '';
    const headSha = process.env.PR_HEAD_SHA || 'HEAD';
    if (baseSha && !commitExists(baseSha)) {
      try {
        execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', baseSha], { stdio: 'ignore' });
      } catch {}
    }
    if (commitExists(baseSha)) {
      try {
        const out = git(['diff', '--name-only', `${baseSha}...${headSha}`]);
        return { forceFull: false, files: out ? out.split(/\r?\n/).filter(Boolean) : [] };
      } catch {
        const out = git(['diff', '--name-only', baseSha, headSha]);
        return { forceFull: false, files: out ? out.split(/\r?\n/).filter(Boolean) : [] };
      }
    }
    return { forceFull: true, files: [] };
  }

  if (event === 'push') {
    const beforeSha = process.env.PUSH_BEFORE_SHA ?? '';
    const afterSha = process.env.PUSH_AFTER_SHA || 'HEAD';
    if (commitExists(beforeSha)) {
      try {
        const out = git(['diff', '--name-only', beforeSha, afterSha]);
        return { forceFull: false, files: out ? out.split(/\r?\n/).filter(Boolean) : [] };
      } catch {
        return { forceFull: true, files: [] };
      }
    }
    return { forceFull: true, files: [] };
  }

  // workflow_dispatch or unknown event: run the full suite.
  return { forceFull: true, files: [] };
}

export function evaluateChanges(files, { eventName = '', ref = '', forceFull = false } = {}) {
  const isMainPush = eventName === 'push' && ref === 'refs/heads/main';
  const isTestFile = (f) => /\.test\.[cm]?[jt]sx?$/.test(f);

  const matches = (re) => files.some((f) => re.test(f));

  const sharedConfig = matches(/^(package\.json|bun\.lock|\.github\/workflows\/ci\.yml|\.github\/scripts\/)/);
  const tsconfig = matches(/^tsconfig\.json$/);
  const testConfig = matches(/^(bunfig\.toml|scripts\/test-setup\.ts)$/);
  const shared = matches(/^shared\//);
  const server = matches(/^server\//);
  const serverNonTest = files.some((f) => /^server\//.test(f) && !isTestFile(f));
  const serverRoutines = matches(/^server\/routines\.ts$/);
  const web = matches(/^web\//);
  const webNonTest = files.some((f) => /^web\//.test(f) && !isTestFile(f));
  const scripts = matches(/^scripts\//);
  const precompress = matches(/^scripts\/precompress\.ts$/);
  const bin = matches(/^bin\//);
  const dockerFiles = matches(/^(Dockerfile|\.dockerignore)$/);

  const hasCiImpact =
    forceFull ||
    sharedConfig ||
    tsconfig ||
    testConfig ||
    shared ||
    server ||
    web ||
    scripts ||
    bin ||
    dockerFiles;

  // Preserve full-suite safety on main pushes whenever any code, config, or container file changes;
  // purely docs/site/example commits still skip heavy CI jobs cleanly.
  const all = forceFull || (isMainPush && hasCiImpact) || sharedConfig;

  const typecheck = all || tsconfig || shared || server || web || scripts;
  const test_server = all || tsconfig || testConfig || shared || server;
  const test_web = all || tsconfig || testConfig || shared || web;
  const test_shared = all || tsconfig || testConfig || shared;
  const test_scripts = all || tsconfig || testConfig || scripts || bin;
  const build = all || tsconfig || shared || web || serverRoutines || precompress;
  const audit = all;
  const docker = all || dockerFiles || shared || serverNonTest || webNonTest || precompress || bin;

  const winDirs = [];
  if (test_server) winDirs.push('server');
  if (test_web) winDirs.push('web');
  if (test_shared) winDirs.push('shared');
  if (test_scripts) winDirs.push('scripts');

  const windows = typecheck || build || winDirs.length > 0;
  const windows_test_dirs =
    winDirs.length === 4 ? '.' : winDirs.join(' ');

  return {
    all,
    has_ci_impact: hasCiImpact,
    typecheck,
    test_server,
    test_web,
    test_shared,
    test_scripts,
    build,
    audit,
    windows,
    windows_test_dirs,
    docker,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { forceFull, files } = getChangedFiles();
  const result = evaluateChanges(files, {
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    ref: process.env.GITHUB_REF ?? '',
    forceFull,
  });

  console.log('Event:', process.env.GITHUB_EVENT_NAME || '(local)', 'Ref:', process.env.GITHUB_REF || '(local)');
  console.log('Force full:', forceFull);
  console.log('Changed files:', files.length ? files.join(', ') : '(none)');
  console.log('Outputs:', JSON.stringify(result, null, 2));

  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    const lines = Object.entries(result).map(([k, v]) => `${k}=${v}`);
    appendFileSync(outputPath, `${lines.join('\n')}\n`);
  }
}
