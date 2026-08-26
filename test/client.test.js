import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { DripFilesClient, DripFilesError, VERSION } from '../src/client.js';

const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('uses the package version as the CLI version', () => {
  assert.equal(VERSION, packageMetadata.version);
});

test('uploads in chunks, completes, and waits until the share link is ready', async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ url: request.url, headers: request.headers, body });

    if (request.url === '/api/v1/free/uploads' && request.method === 'POST') {
      const payload = JSON.parse(body.toString());
      assert.deepEqual(payload.files, [{ name: 'demo.txt', size: 12 }]);
      return json(response, 201, {
        ok: true,
        upload_id: 'test123',
        upload_token: 'dft_test',
        chunk_size: 5,
        files: [{ name: 'demo.txt', size: 12, file_uid: 'uid_test' }],
        upload_url: '/api/v1/free/uploads/test123/files',
        complete_url: '/api/v1/free/uploads/test123/complete',
        status_url: '/api/v1/free/uploads/test123',
      });
    }
    if (request.url === '/api/v1/free/uploads/test123/files') {
      assert.equal(request.method, 'PUT');
      assert.equal(request.headers['x-upload-token'], 'dft_test');
      assert.equal(request.headers['x-file-uid'], 'uid_test');
      assert.equal(request.headers['x-file-name'], 'demo.txt');
      return json(response, 200, { ok: true });
    }
    if (request.url === '/api/v1/free/uploads/test123/complete') {
      return json(response, 200, { ok: true, status: 'processing' });
    }
    if (request.url === '/api/v1/free/uploads/test123') {
      assert.equal(request.headers['x-upload-token'], 'dft_test');
      return json(response, 200, {
        ok: true,
        status: 'ready',
        url: `${baseUrl(server)}/test123`,
        expires_at: 123456789,
      });
    }
    response.writeHead(404).end();
  });
  await listen(server);
  t.after(() => server.close());

  const directory = await mkdtemp(join(tmpdir(), 'dripfiles-client-'));
  const path = join(directory, 'demo.txt');
  await writeFile(path, 'hello world!');
  const progress = [];
  const client = new DripFilesClient({ baseUrl: baseUrl(server), apiKey: '' });
  const result = await client.upload([path], { onProgress: (event) => progress.push(event.transferred) });

  assert.equal(result.url, `${baseUrl(server)}/test123`);
  assert.equal(result.bytes, 12);
  assert.deepEqual(progress, [5, 10, 12]);
  const chunks = requests.filter((request) => request.url.endsWith('/files'));
  assert.deepEqual(chunks.map((request) => request.headers['content-range']), [
    'bytes 0-4/12',
    'bytes 5-9/12',
    'bytes 10-11/12',
  ]);
  assert.deepEqual(chunks.map((request) => request.body.toString()), ['hello', ' worl', 'd!']);
});

test('downloads a UTF-8 filename and retries older servers with a curl user agent', async (t) => {
  let calls = 0;
  const content = Buffer.from('hello world\n');
  const server = createServer((request, response) => {
    calls += 1;
    if (!request.headers['user-agent'].startsWith('curl/')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' });
      return response.end('<html>download page</html>');
    }
    response.writeHead(200, {
      'content-type': 'text/plain',
      'content-length': String(content.length),
      'content-disposition': "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20final%3F.txt",
    });
    response.end(content);
  });
  await listen(server);
  t.after(() => server.close());

  const directory = await mkdtemp(join(tmpdir(), 'dripfiles-download-'));
  const progress = [];
  const client = new DripFilesClient({ baseUrl: baseUrl(server), apiKey: '' });
  const result = await client.download(`${baseUrl(server)}/share`, {
    output: directory,
    onProgress: (event) => progress.push(event.transferred),
  });

  assert.equal(calls, 2);
  assert.equal(result.path, join(directory, 'résumé final_.txt'));
  assert.equal(await readFile(result.path, 'utf8'), 'hello world\n');
  assert.equal(progress.at(-1), content.length);

  await assert.rejects(
    () => client.download(`${baseUrl(server)}/share`, { output: directory }),
    (error) => error instanceof DripFilesError && /Already exists/.test(error.message),
  );
});

test('resolves an ID against the configured server URL', () => {
  const client = new DripFilesClient({ baseUrl: 'https://files.example.test/', apiKey: '' });
  assert.equal(client.resolveDownloadUrl('AbC_123'), 'https://files.example.test/AbC_123');
});

test('validates and uses a personal API key throughout an upload', async (t) => {
  const seen = [];
  const server = createServer(async (request, response) => {
    await readBody(request);
    seen.push({
      url: request.url,
      authorization: request.headers.authorization,
      uploadToken: request.headers['x-upload-token'],
    });

    if (request.url === '/api/v1/me') {
      assert.equal(request.headers.authorization, 'Bearer df_test_secret');
      return json(response, 200, { ok: true, email: 'cli@example.test', tier: 'premium' });
    }
    if (request.url === '/api/v1/uploads') {
      assert.equal(request.headers.authorization, 'Bearer df_test_secret');
      return json(response, 201, {
        ok: true,
        tier: 'premium',
        upload_id: 'private1',
        upload_token: 'dfu_private',
        chunk_size: 1024,
        files: [{ name: 'private.txt', size: 7, file_uid: 'uid_private' }],
      });
    }
    if (request.url === '/api/v1/uploads/private1/files') {
      assert.equal(request.headers['x-upload-token'], 'dfu_private');
      assert.equal(request.headers.authorization, undefined);
      return json(response, 200, { ok: true });
    }
    if (request.url === '/api/v1/uploads/private1/complete') {
      assert.equal(request.headers['x-upload-token'], 'dfu_private');
      assert.equal(request.headers.authorization, undefined);
      return json(response, 200, {
        ok: true,
        status: 'ready',
        url: `${baseUrl(server)}/private1`,
        tier: 'premium',
      });
    }
    response.writeHead(404).end();
  });
  await listen(server);
  t.after(() => server.close());

  const directory = await mkdtemp(join(tmpdir(), 'dripfiles-key-'));
  const path = join(directory, 'private.txt');
  await writeFile(path, 'private');
  const client = new DripFilesClient({ baseUrl: baseUrl(server), apiKey: 'df_test_secret' });

  assert.equal((await client.me()).email, 'cli@example.test');
  const result = await client.upload([path]);
  assert.equal(result.tier, 'premium');
  assert.deepEqual(seen.map((request) => request.url), [
    '/api/v1/me',
    '/api/v1/uploads',
    '/api/v1/uploads/private1/files',
    '/api/v1/uploads/private1/complete',
  ]);
});

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
}

function baseUrl(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}
