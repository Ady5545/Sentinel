import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createManifest, verifyManifest } from './release-qualification.mjs';

const commit = 'a'.repeat(40);
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.3.0' }));
  await mkdir(path.join(root, 'release'), { recursive: true });
  await writeFile(path.join(root, 'release', 'SENTINEL-test.zip'), Buffer.from('fixture-app-binary'));
  return root;
}

test('creates a pinned manifest and verifies file bytes and sidecar checksum', async t => {
  const root = await fixture(t);
  const outputPath = 'release/qualification-manifest.json';
  const manifest = await createManifest({
    sourceCommit: commit,
    target: 'macos-arm64',
    artifactPaths: ['release/SENTINEL-test.zip'],
    outputPath,
    root,
    generatedAt: '2026-10-27T00:00:00.000Z'
  });
  assert.equal(manifest.sourceCommit, commit);
  assert.equal(manifest.artifacts.length, 1);
  assert.match(manifest.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(await readFile(path.join(root, outputPath), 'utf8')).packageVersion, '0.3.0');
  assert.equal((await verifyManifest({ manifestPath: outputPath, expectedCommit: commit, root })).ok, true);
});

test('rejects a source commit mismatch', async t => {
  const root = await fixture(t);
  await createManifest({
    sourceCommit: commit, target: 'windows-x64',
    artifactPaths: ['release/SENTINEL-test.zip'],
    outputPath: 'release/qualification-manifest.json', root
  });
  await assert.rejects(
    verifyManifest({ manifestPath: 'release/qualification-manifest.json', expectedCommit: 'b'.repeat(40), root }),
    /Source commit mismatch/
  );
});

test('detects artifact tampering after manifest creation', async t => {
  const root = await fixture(t);
  await createManifest({
    sourceCommit: commit, target: 'windows-x64',
    artifactPaths: ['release/SENTINEL-test.zip'],
    outputPath: 'release/qualification-manifest.json', root
  });
  await writeFile(path.join(root, 'release', 'SENTINEL-test.zip'), 'changed-after-hash');
  await assert.rejects(
    verifyManifest({ manifestPath: 'release/qualification-manifest.json', expectedCommit: commit, root }),
    /Artifact integrity mismatch/
  );
});

test('rejects unpinned SHAs, invalid targets and empty artifact lists', async t => {
  const root = await fixture(t);
  await assert.rejects(createManifest({
    sourceCommit: 'main', target: 'macos-arm64',
    artifactPaths: ['release/SENTINEL-test.zip'], outputPath: 'release/out.json', root
  }), /full 40-character Git SHA/);
  await assert.rejects(createManifest({
    sourceCommit: commit, target: 'unknown-target',
    artifactPaths: ['release/SENTINEL-test.zip'], outputPath: 'release/out.json', root
  }), /Unsupported target/);
  await assert.rejects(createManifest({
    sourceCommit: commit, target: 'macos-arm64',
    artifactPaths: [], outputPath: 'release/out.json', root
  }), /At least one packaged artifact/);
});

test('detects a modified checksum sidecar', async t => {
  const root = await fixture(t);
  await createManifest({
    sourceCommit: commit, target: 'macos-arm64',
    artifactPaths: ['release/SENTINEL-test.zip'],
    outputPath: 'release/qualification-manifest.json', root
  });
  await writeFile(path.join(root, 'release', 'qualification-manifest.json.sha256'), '0'.repeat(64) + '  qualification-manifest.json\n');
  await assert.rejects(
    verifyManifest({ manifestPath: 'release/qualification-manifest.json', expectedCommit: commit, root }),
    /Manifest checksum mismatch/
  );
});
