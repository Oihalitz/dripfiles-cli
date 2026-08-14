import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { DripFilesError } from './client.js';

export function configPath(environment = process.env) {
  if (environment.DRIPFILES_CONFIG_PATH) return environment.DRIPFILES_CONFIG_PATH;
  if (process.platform === 'win32' && environment.APPDATA) {
    return join(environment.APPDATA, 'dripfiles', 'config.json');
  }
  const configHome = environment.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configHome, 'dripfiles', 'config.json');
}

export async function readConfig(options = {}) {
  const path = options.path ?? configPath(options.environment);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new DripFilesError(`Could not read the DripFiles configuration: ${error.message}`, { cause: error });
  }

  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    throw new DripFilesError(`The DripFiles configuration does not contain valid JSON: ${path}`, { cause: error });
  }
}

export async function saveConfig(value, options = {}) {
  const path = options.path ?? configPath(options.environment);
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => {});
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return path;
}

export async function clearConfig(options = {}) {
  const path = options.path ?? configPath(options.environment);
  await rm(path, { force: true });
  return path;
}
