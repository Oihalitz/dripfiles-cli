import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { CliUsageError, parseArguments, run } from '../src/cli.js';

test('parses commands and short or long options', () => {
  assert.deepEqual(
    pick(parseArguments(['upload', 'one.zip', 'two.pdf', '-m', 'Delivery', '--json'])),
    {
      command: 'upload',
      inputs: ['one.zip', 'two.pdf'],
      message: 'Delivery',
      output: null,
      force: false,
      json: true,
    },
  );
  assert.deepEqual(
    pick(parseArguments(['download', 'AbC123', '--output=./downloads', '--force'])),
    {
      command: 'download',
      inputs: ['AbC123'],
      message: '',
      output: './downloads',
      force: true,
      json: false,
    },
  );
  assert.throws(() => parseArguments(['--unknown']), CliUsageError);
  assert.equal(parseArguments(['help']).help, true);
});

test('displays help when run without arguments', async () => {
  const stdout = captureStream();
  await run([], { stdout, stderr: captureStream() });
  assert.match(stdout.text(), /dripfiles <file>/);
  assert.match(stdout.text(), /dripfiles auth login/);
});

test('the implicit form uploads a local path and writes only the URL to stdout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dripfiles-cli-'));
  await writeFile(join(directory, 'release.zip'), 'zip');
  const stdout = captureStream();
  const stderr = captureStream();
  let received;
  const client = {
    async upload(paths, options) {
      received = { paths, options };
      return { id: 'id1', url: 'https://dripfiles.com/id1', bytes: 3, files: [] };
    },
  };

  await run(['release.zip', '--quiet'], { client, cwd: directory, stdout, stderr });

  assert.deepEqual(received.paths, [join(directory, 'release.zip')]);
  assert.equal(stdout.text(), 'https://dripfiles.com/id1\n');
  assert.equal(stderr.text(), '');
});

test('a URL triggers an implicit download and honors --output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dripfiles-cli-download-'));
  const stdout = captureStream();
  let received;
  const client = {
    async download(url, options) {
      received = { url, options };
      return { url, path: join(directory, 'output.bin'), bytes: 10, filename: 'output.bin' };
    },
  };

  await run(['https://dripfiles.com/AbC', '-o', 'output.bin', '--json'], {
    client,
    cwd: directory,
    stdout,
    stderr: captureStream(),
  });

  assert.equal(received.url, 'https://dripfiles.com/AbC');
  assert.equal(received.options.output, join(directory, 'output.bin'));
  assert.deepEqual(JSON.parse(stdout.text()), {
    url: 'https://dripfiles.com/AbC',
    path: join(directory, 'output.bin'),
    bytes: 10,
    filename: 'output.bin',
  });
});

test('an output path ending in a slash preserves the directory intent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dripfiles-cli-directory-'));
  let output;
  const client = {
    async download(_url, options) {
      output = options.output;
      return { url: 'https://dripfiles.com/X', path: join(directory, 'destination', 'x'), bytes: 1 };
    },
  };

  await run(['download', 'X', '-o', 'destination/', '--quiet'], {
    client,
    cwd: directory,
    stdout: captureStream(),
    stderr: captureStream(),
  });

  assert.match(output, /destination[\\\/]$/);
});

test('auth login validates and saves the API key; status and logout manage it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dripfiles-auth-'));
  const path = join(directory, 'config', 'config.json');
  const createdWith = [];
  const createClient = (options) => {
    createdWith.push(options);
    return {
      async me() {
        return { ok: true, email: 'user@example.test', tier_label: 'Premium' };
      },
    };
  };

  const loginOutput = captureStream();
  await run(['auth', 'login', '--json', '--base-url', 'https://files.example.test'], {
    configPath: path,
    createClient,
    readApiKey: async () => 'df_saved_key',
    stdout: loginOutput,
    stderr: captureStream(),
  });
  assert.equal(createdWith[0].apiKey, 'df_saved_key');
  assert.equal(JSON.parse(loginOutput.text()).account.email, 'user@example.test');

  const statusOutput = captureStream();
  await run(['auth', 'status', '--json'], {
    configPath: path,
    createClient,
    stdout: statusOutput,
    stderr: captureStream(),
  });
  assert.equal(createdWith[1].baseUrl, 'https://files.example.test');
  assert.equal(JSON.parse(statusOutput.text()).source, 'config');

  await run(['auth', 'logout', '--quiet'], {
    configPath: path,
    stdout: captureStream(),
    stderr: captureStream(),
  });
  await assert.rejects(() => readFile(path), (error) => error.code === 'ENOENT');
});

function pick(parsed) {
  return {
    command: parsed.command,
    inputs: parsed.inputs,
    message: parsed.message,
    output: parsed.output,
    force: parsed.force,
    json: parsed.json,
  };
}

function captureStream() {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  stream.text = () => Buffer.concat(chunks).toString();
  return stream;
}
