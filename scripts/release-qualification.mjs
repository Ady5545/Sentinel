#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const QUALIFICATION_SCHEMA_VERSION = 1;
const TARGETS = new Set(['macos-arm64', 'windows-x64', 'linux-x64']);

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function assertCommitSha(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error('Source commit must be a full 40-character Git SHA; refusing an unpinned manifest.');
  }
  return value.toLowerCase();
}

function normalizeRepoPath(value, root) {
  const absolute = path.resolve(root, value);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Artifact path must be a non-empty file path inside the workspace: ' + value);
  }
  return relative.split(path.sep).join('/');
}

async function readRegularFile(filePath, label) {
  const info = await fs.lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(label + ' must be a regular, non-symlink file: ' + filePath);
  }
  if (info.size <= 0) throw new Error(label + ' is empty: ' + filePath);
  return { bytes: await fs.readFile(filePath), size: info.size };
}

export async function createManifest({ sourceCommit, target, artifactPaths, outputPath, root = process.cwd(), generatedAt = new Date().toISOString() }) {
  const commit = assertCommitSha(sourceCommit);
  if (!TARGETS.has(target)) throw new Error('Unsupported target: ' + target + '. Expected one of: ' + [...TARGETS].join(', '));
  if (!Array.isArray(artifactPaths) || artifactPaths.length === 0) throw new Error('At least one packaged artifact is required.');
  if (!outputPath) throw new Error('Manifest output path is required.');

  const artifacts = [];
  const seen = new Set();
  for (const item of artifactPaths) {
    const relative = normalizeRepoPath(item, root);
    if (seen.has(relative)) throw new Error('Duplicate artifact path: ' + relative);
    seen.add(relative);
    const absolute = path.resolve(root, relative);
    const { bytes, size } = await readRegularFile(absolute, 'Artifact');
    artifacts.push({ path: relative, bytes: size, sha256: sha256(bytes) });
  }
  artifacts.sort((a, b) => a.path.localeCompare(b.path));

  const manifest = {
    schemaVersion: QUALIFICATION_SCHEMA_VERSION,
    product: 'SENTINEL Research Environment',
    packageVersion: JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version,
    target,
    sourceCommit: commit,
    generatedAt,
    integrity: 'SHA-256',
    artifacts
  };
  const absoluteOutput = path.resolve(root, outputPath);
  const outputRelative = normalizeRepoPath(absoluteOutput, root);
  if (seen.has(outputRelative)) throw new Error('Manifest output must not also be listed as a packaged artifact.');
  const serialized = JSON.stringify(manifest, null, 2) + '\n';
  await fs.mkdir(path.dirname(absoluteOutput), { recursive: true });
  await fs.writeFile(absoluteOutput, serialized, { flag: 'w' });
  await fs.writeFile(absoluteOutput + '.sha256', sha256(serialized) + '  ' + path.basename(absoluteOutput) + '\n', { flag: 'w' });
  return manifest;
}

export async function verifyManifest({ manifestPath, expectedCommit, root = process.cwd() }) {
  if (!manifestPath) throw new Error('Manifest path is required.');
  const commit = expectedCommit ? assertCommitSha(expectedCommit) : null;
  const absoluteManifest = path.resolve(root, manifestPath);
  const manifestFile = await readRegularFile(absoluteManifest, 'Manifest');
  const manifestText = manifestFile.bytes.toString('utf8');
  const sidecarPath = absoluteManifest + '.sha256';
  const { bytes: sidecar } = await readRegularFile(sidecarPath, 'Manifest checksum sidecar');
  const sidecarMatch = sidecar.toString('utf8').trim().match(/^([0-9a-f]{64})  (.+)$/i);
  if (!sidecarMatch || sidecarMatch[2] !== path.basename(absoluteManifest)) {
    throw new Error('Manifest SHA-256 sidecar is missing, malformed, or names the wrong file.');
  }
  if (sha256(manifestText) !== sidecarMatch[1].toLowerCase()) throw new Error('Manifest checksum mismatch.');
  const manifest = JSON.parse(manifestText);
  if (manifest.schemaVersion !== QUALIFICATION_SCHEMA_VERSION) throw new Error('Unsupported qualification manifest schema.');
  assertCommitSha(manifest.sourceCommit);
  if (commit && manifest.sourceCommit.toLowerCase() !== commit) {
    throw new Error('Source commit mismatch: manifest=' + manifest.sourceCommit + ', expected=' + commit);
  }
  if (!TARGETS.has(manifest.target)) throw new Error('Manifest target is not recognized.');
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) throw new Error('Manifest has no artifact records.');

  for (const entry of manifest.artifacts) {
    if (!entry || typeof entry.path !== 'string' || entry.path.startsWith('/') || entry.path.split('/').includes('..')) {
      throw new Error('Manifest contains an invalid artifact path.');
    }
    const artifactPath = path.resolve(root, entry.path.split('/').join(path.sep));
    normalizeRepoPath(artifactPath, root);
    const { bytes, size } = await readRegularFile(artifactPath, 'Artifact');
    if (size !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new Error('Artifact integrity mismatch: ' + entry.path);
    }
  }
  return { ok: true, sourceCommit: manifest.sourceCommit, target: manifest.target, artifactsVerified: manifest.artifacts.length };
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const options = { mode, artifacts: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--artifact') options.artifacts.push(rest[++index]);
    else if (arg === '--commit') options.sourceCommit = rest[++index];
    else if (arg === '--target') options.target = rest[++index];
    else if (arg === '--output') options.outputPath = rest[++index];
    else if (arg === '--manifest') options.manifestPath = rest[++index];
    else if (arg === '--root') options.root = rest[++index];
    else throw new Error('Unknown argument: ' + arg);
    if (arg !== '--artifact' && rest[index] === undefined) throw new Error('Missing value for ' + arg);
    if (arg === '--artifact' && !options.artifacts.at(-1)) throw new Error('Missing value for --artifact');
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.mode === 'create') {
    const manifest = await createManifest({
      sourceCommit: options.sourceCommit,
      target: options.target,
      artifactPaths: options.artifacts,
      outputPath: options.outputPath,
      root: options.root || process.cwd()
    });
    console.log('QUALIFICATION_MANIFEST_CREATED ' + options.outputPath);
    console.log('SOURCE_COMMIT ' + manifest.sourceCommit);
    console.log('TARGET ' + manifest.target);
    console.log('ARTIFACTS ' + manifest.artifacts.length);
    return;
  }
  if (options.mode === 'verify') {
    const result = await verifyManifest({
      manifestPath: options.manifestPath,
      expectedCommit: options.sourceCommit,
      root: options.root || process.cwd()
    });
    console.log('QUALIFICATION_MANIFEST_VERIFIED ' + result.sourceCommit);
    console.log('TARGET ' + result.target);
    console.log('ARTIFACTS_VERIFIED ' + result.artifactsVerified);
    return;
  }
  throw new Error('Usage: node scripts/release-qualification.mjs create --commit <full-sha> --target <target> --output <path> --artifact <path>... | verify --manifest <path> [--commit <full-sha>]');
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(scriptPath).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error('QUALIFICATION_ERROR ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
