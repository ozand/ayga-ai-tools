import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isPathExcluded,
  findZipTool,
  createPackage,
  listZipEntries,
  EXCLUDED_PATTERNS
} from '../utils/package.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

test('findZipTool returns an available tool on the current system', () => {
  const tool = findZipTool();
  assert.ok(
    tool === 'zip' || tool === '7z' || tool === '7zz',
    `Expected an available tool (zip/7z/7zz), got: ${tool}`
  );
});

test('isPathExcluded matches excluded directories and files correctly', () => {
  // Excluded patterns
  assert.strictEqual(isPathExcluded('.git/config'), true);
  assert.strictEqual(isPathExcluded('.git\\HEAD'), true);
  assert.strictEqual(isPathExcluded('.pi/session.json'), true);
  assert.strictEqual(isPathExcluded('.pi\\state'), true);
  assert.strictEqual(isPathExcluded('test/artifact-bridge.test.js'), true);
  assert.strictEqual(isPathExcluded('test\\simple-dom.js'), true);
  assert.strictEqual(isPathExcluded('docs/ARTIFACT-DOM-MAP.md'), true);
  assert.strictEqual(isPathExcluded('PROJECT_PLAN.md'), true);
  assert.strictEqual(isPathExcluded('extension.zip'), true);
  assert.strictEqual(isPathExcluded('some_other.zip'), true);
  assert.strictEqual(isPathExcluded('.artifact-test.png'), true);
  assert.strictEqual(isPathExcluded('images/.artifact-test.png'), true);
  assert.strictEqual(isPathExcluded('.DS_Store'), true);
  assert.strictEqual(isPathExcluded('popup/.DS_Store'), true);
  assert.strictEqual(isPathExcluded('node_modules/foo/bar.js'), true);

  // Included patterns
  assert.strictEqual(isPathExcluded('manifest.json'), false);
  assert.strictEqual(isPathExcluded('background.js'), false);
  assert.strictEqual(isPathExcluded('content.js'), false);
  assert.strictEqual(isPathExcluded('artifact-shell.js'), false);
  assert.strictEqual(isPathExcluded('artifact-frame.js'), false);
  assert.strictEqual(isPathExcluded('popup/popup.html'), false);
  assert.strictEqual(isPathExcluded('popup/popup.js'), false);
  assert.strictEqual(isPathExcluded('utils/artifact-bridge.js'), false);
  assert.strictEqual(isPathExcluded('utils/artifact-converter.js'), false);
  assert.strictEqual(isPathExcluded('utils/artifact-download.js'), false);
  assert.strictEqual(isPathExcluded('utils/package.js'), false);
  assert.strictEqual(isPathExcluded('images/128.png'), false);
  assert.strictEqual(isPathExcluded('images/anthropic.png'), false);
});

test('createPackage and listZipEntries produce valid archive without excluded files', () => {
  const testZipName = 'test-temp-package.zip';
  const testZipPath = path.resolve(rootDir, testZipName);

  try {
    const res = createPackage(testZipName, rootDir);
    assert.ok(fs.existsSync(testZipPath), 'Archive file should exist');

    const entries = listZipEntries(testZipName, rootDir);
    assert.ok(entries.length > 0, 'Archive should contain entries');

    // Required files in extension package
    assert.ok(entries.includes('manifest.json'), 'Must contain manifest.json');
    assert.ok(entries.includes('background.js'), 'Must contain background.js');
    assert.ok(entries.includes('artifact-frame.js'), 'Must contain artifact-frame.js');
    assert.ok(entries.includes('artifact-shell.js'), 'Must contain artifact-shell.js');
    assert.ok(entries.includes('utils/artifact-bridge.js'), 'Must contain utils/artifact-bridge.js');
    assert.ok(entries.includes('utils/artifact-converter.js'), 'Must contain utils/artifact-converter.js');
    assert.ok(entries.includes('utils/artifact-download.js'), 'Must contain utils/artifact-download.js');

    // Excluded patterns check
    for (const entry of entries) {
      assert.strictEqual(
        isPathExcluded(entry),
        false,
        `Archive contains excluded entry: ${entry}`
      );
    }
  } finally {
    if (fs.existsSync(testZipPath)) {
      fs.unlinkSync(testZipPath);
    }
  }
});
