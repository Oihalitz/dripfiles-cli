import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { clearConfig, readConfig, saveConfig } from '../src/config.js';

test('guarda la configuración de forma privada y la puede eliminar', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dripfiles-config-'));
  const path = join(directory, 'nested', 'config.json');
  const value = { apiKey: 'df_secret', baseUrl: 'https://dripfiles.com' };

  assert.deepEqual(await readConfig({ path }), {});
  assert.equal(await saveConfig(value, { path }), path);
  assert.deepEqual(await readConfig({ path }), value);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  assert.equal(await clearConfig({ path }), path);
  assert.deepEqual(await readConfig({ path }), {});
});
