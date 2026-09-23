import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readBundledProvenance } from '../src/provenance.js';

test('a bundled provenance receipt describes only its matching payload', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'groundskeeper-provenance-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'git-groundskeeper.js');
  const receipt = path.join(directory, 'GitGroundskeeperProvenance.json');
  fs.writeFileSync(script, 'console.log("groundskeeper");\n');
  const payloadSHA256 = createHash('sha256').update(fs.readFileSync(script)).digest('hex');
  fs.writeFileSync(receipt, JSON.stringify({
    schemaVersion: 1,
    name: 'git-groundskeeper',
    version: '0.2.0',
    commit: 'a'.repeat(40),
    dirty: false,
    source: 'embedded-bundle',
    payloadSHA256,
  }));

  assert.deepEqual(readBundledProvenance(script), {
    name: 'git-groundskeeper',
    version: '0.2.0',
    commit: 'a'.repeat(40),
    dirty: false,
    source: 'embedded-bundle',
  });

  fs.appendFileSync(script, '// changed after receipt was written\n');
  assert.equal(readBundledProvenance(script), null);
});

test('a missing or malformed bundled receipt does not supply provenance', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'groundskeeper-provenance-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'git-groundskeeper.js');
  const receipt = path.join(directory, 'GitGroundskeeperProvenance.json');
  fs.writeFileSync(script, 'console.log("groundskeeper");\n');
  assert.equal(readBundledProvenance(script), null);
  fs.writeFileSync(receipt, JSON.stringify({ schemaVersion: 1, commit: 'not-a-commit' }));
  assert.equal(readBundledProvenance(script), null);
});
