#!/usr/bin/env node
// Renders the Inputs/Outputs tables in README.md from action.yml.
// Usage:
//   node scripts/render-action-tables.mjs          # rewrite README between markers
//   node scripts/render-action-tables.mjs --check  # exit 1 if README is stale

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = path.join(repoRoot, 'README.md');

const manifest = parse(readFileSync(path.join(repoRoot, 'action.yml'), 'utf8'));

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function renderInputsTable(inputs) {
  const lines = ['| Name | Description | Required | Default |', '| --- | --- | --- | --- |'];
  for (const [name, spec] of Object.entries(inputs ?? {})) {
    const required = spec.required === true ? 'yes' : 'no';
    const def = spec.default !== undefined ? `\`${escapeCell(spec.default)}\`` : '';
    lines.push(`| \`${name}\` | ${escapeCell(spec.description)} | ${required} | ${def} |`);
  }
  return lines.join('\n');
}

function renderOutputsTable(outputs) {
  const lines = ['| Name | Description |', '| --- | --- |'];
  for (const [name, spec] of Object.entries(outputs ?? {})) {
    lines.push(`| \`${name}\` | ${escapeCell(spec.description)} |`);
  }
  return lines.join('\n');
}

function replaceBetween(content, startMarker, endMarker, body) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md is missing markers ${startMarker} / ${endMarker}`);
  }
  return (
    content.slice(0, start + startMarker.length) +
    '\n' +
    body +
    '\n' +
    content.slice(end)
  );
}

export function renderReadme(content) {
  let next = replaceBetween(
    content,
    '<!-- inputs-table:start -->',
    '<!-- inputs-table:end -->',
    renderInputsTable(manifest.inputs)
  );
  next = replaceBetween(
    next,
    '<!-- outputs-table:start -->',
    '<!-- outputs-table:end -->',
    renderOutputsTable(manifest.outputs)
  );
  return next;
}

const current = readFileSync(readmePath, 'utf8');
const next = renderReadme(current);

if (process.argv.includes('--check')) {
  if (current !== next) {
    process.stderr.write('README.md input/output tables are stale. Run: npm run docs:tables\n');
    process.exit(1);
  }
  process.stderr.write('README.md tables are in sync with action.yml.\n');
} else if (current !== next) {
  writeFileSync(readmePath, next);
  process.stderr.write('README.md tables regenerated from action.yml.\n');
} else {
  process.stderr.write('README.md tables already up to date.\n');
}
