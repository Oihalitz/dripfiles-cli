import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';

export const VERSION = '0.1.0';
export const DEFAULT_BASE_URL = 'https://dripfiles.com';

const DEFAULT_REQUEST_TIMEOUT = 5 * 60 * 1000;
const DEFAULT_READY_TIMEOUT = 5 * 60 * 1000;

export class DripFilesError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'DripFilesError';
    this.status = options.status;
    this.details = options.details;
  }
}

export class DripFilesClient {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.DRIPFILES_BASE_URL ?? DEFAULT_BASE_URL);
    this.apiKey = String(options.apiKey ?? process.env.DRIPFILES_API_KEY ?? '').trim();
    this.fetch = options.fetch ?? globalThis.fetch;
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
    this.readyTimeout = options.readyTimeout ?? DEFAULT_READY_TIMEOUT;

    if (typeof this.fetch !== 'function') {
      throw new DripFilesError('Esta versión de Node.js no incluye fetch. Usa Node.js 20 o posterior.');
    }
  }

  async upload(inputPaths, options = {}) {
    const signal = options.signal;
    const files = await inspectFiles(inputPaths);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const uploadsPath = this.apiKey ? '/api/v1/uploads' : '/api/v1/free/uploads';

    const session = await this.#requestJson(this.#apiUrl(uploadsPath), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.#authHeaders() },
      body: JSON.stringify({
        message: options.message ?? '',
        files: files.map(({ name, size }) => ({ name, size })),
      }),
      signal,
    });

    const uploadId = session.upload_id;
    const token = session.upload_token;
    const remoteFiles = session.files;
    if (!uploadId || (!this.apiKey && !token) || !Array.isArray(remoteFiles) || remoteFiles.length !== files.length) {
      throw new DripFilesError('DripFiles devolvió una sesión de subida incompleta.', { details: session });
    }

    const chunkSize = positiveInteger(session.chunk_size, 1024 * 1024);
    let completedBytes = 0;

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const fileUid = remoteFiles[index]?.file_uid;
      if (!fileUid) {
        throw new DripFilesError(`DripFiles no devolvió un identificador para ${file.name}.`);
      }

      if (file.size === 0) {
        await this.#uploadChunk({
          url: session.upload_url,
          uploadsPath,
          uploadId,
          token,
          file,
          fileUid,
          start: 0,
          end: -1,
          signal,
        });
        options.onProgress?.({ transferred: completedBytes, total: totalBytes, file: file.name });
        continue;
      }

      for (let start = 0; start < file.size; start += chunkSize) {
        const end = Math.min(start + chunkSize, file.size) - 1;
        await this.#uploadChunk({
          url: session.upload_url,
          uploadsPath,
          uploadId,
          token,
          file,
          fileUid,
          start,
          end,
          signal,
        });
        completedBytes += end - start + 1;
        options.onProgress?.({ transferred: completedBytes, total: totalBytes, file: file.name });
      }
    }

    let result = await this.#requestJson(resolveServerUrl(session.complete_url, this.baseUrl, `${uploadsPath}/${encodeURIComponent(uploadId)}/complete`), {
      method: 'POST',
      headers: this.#authHeaders(token),
      signal,
    });

    if (result.status !== 'ready') {
      result = await this.#waitUntilReady({
        statusUrl: session.status_url,
        uploadsPath,
        uploadId,
        token,
        signal,
        onStatus: options.onStatus,
      });
    }

    const url = result.url ?? session.url ?? new URL(`/${uploadId}`, this.baseUrl).href;
    return {
      id: uploadId,
      url,
      bytes: totalBytes,
      files: files.map(({ name, size, path }) => ({ name, size, path })),
      expiresAt: result.expires_at ?? session.expires_at,
      status: result.status ?? 'ready',
      tier: result.tier ?? session.tier,
    };
  }

  async me(options = {}) {
    if (!this.apiKey) {
      throw new DripFilesError('No hay ninguna API key configurada. Usa "dripfiles auth login".');
    }
    return this.#requestJson(this.#apiUrl('/api/v1/me'), {
      method: 'GET',
      headers: this.#authHeaders(),
      signal: options.signal,
    });
  }

  async download(input, options = {}) {
    const url = this.resolveDownloadUrl(input);
    let response = await this.#fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/octet-stream,*/*;q=0.8',
        'user-agent': `dripfiles-cli/${VERSION}`,
      },
      redirect: 'follow',
      signal: options.signal,
    }, false);

    // DripFiles versions released before the official CLI only recognized
    // curl/wget. Retry with a compatible UA when an older server sends HTML.
    if (
      response.ok
      && response.headers.get('content-type')?.toLowerCase().includes('text/html')
      && !response.headers.get('content-disposition')?.toLowerCase().includes('attachment')
    ) {
      await response.body?.cancel().catch(() => {});
      response = await this.#fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/octet-stream,*/*;q=0.8',
          'user-agent': `curl/8.0 dripfiles-cli/${VERSION}`,
        },
        redirect: 'follow',
        signal: options.signal,
      }, false);
    }

    if (!response.ok) {
      throw await responseError(response, `No se pudo descargar ${url}`);
    }
    if (!response.body) {
      throw new DripFilesError('DripFiles no devolvió contenido para descargar.');
    }

    const disposition = response.headers.get('content-disposition');
    const suggestedName = safeFilename(filenameFromDisposition(disposition) ?? filenameFromUrl(response.url));
    const target = await resolveDownloadTarget(options.output, suggestedName);
    const part = `${target}.part`;

    if (!options.force) {
      await assertMissing(target);
      await assertMissing(part);
    } else {
      await rm(part, { force: true });
    }
    await mkdir(dirname(target), { recursive: true });

    const total = nonNegativeInteger(response.headers.get('content-length'));
    let transferred = 0;
    const progress = new Transform({
      transform(chunk, _encoding, callback) {
        transferred += chunk.length;
        options.onProgress?.({ transferred, total, file: basename(target) });
        callback(null, chunk);
      },
    });

    try {
      const source = Readable.fromWeb(response.body);
      await pipeline(source, progress, createWriteStream(part, { flags: options.force ? 'w' : 'wx' }), {
        signal: options.signal,
      });
      if (options.force) {
        await rm(target, { force: true });
      }
      await rename(part, target);
    } catch (error) {
      await rm(part, { force: true }).catch(() => {});
      if (error?.code === 'EEXIST') {
        throw new DripFilesError(`Ya existe: ${target}. Usa --force para sobrescribirlo.`, { cause: error });
      }
      throw error;
    }

    return { url, path: target, bytes: transferred, filename: basename(target) };
  }

  resolveDownloadUrl(input) {
    const value = String(input ?? '').trim();
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new DripFilesError('La URL debe usar HTTP o HTTPS.');
      }
      return url.href;
    }
    if (/^[A-Za-z0-9_-]+$/.test(value)) {
      return new URL(`/${value}`, this.baseUrl).href;
    }
    throw new DripFilesError(`URL o identificador de DripFiles no válido: ${value}`);
  }

  async #uploadChunk({ url, uploadsPath, uploadId, token, file, fileUid, start, end, signal }) {
    const endpoint = resolveServerUrl(url, this.baseUrl, `${uploadsPath}/${encodeURIComponent(uploadId)}/files`);
    let lastError;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const multipart = createMultipartBody({ file, fileUid, start, end });
      const headers = {
        'content-type': `multipart/form-data; boundary=${multipart.boundary}`,
        'content-length': String(multipart.length),
        ...this.#authHeaders(token),
      };
      if (end >= start) {
        headers['content-range'] = `bytes ${start}-${end}/${file.size}`;
      }

      try {
        const response = await this.#fetch(endpoint, {
          method: 'POST',
          headers,
          body: multipart.stream(),
          duplex: 'half',
          signal,
        });
        if (response.ok) {
          await parseJsonResponse(response);
          return;
        }
        const error = await responseError(response, `No se pudo subir ${file.name}`);
        if (!isRetryableStatus(response.status) || attempt === 3) throw error;
        lastError = error;
      } catch (error) {
        if (signal?.aborted || attempt === 3 || (error instanceof DripFilesError && !isRetryableStatus(error.status))) {
          throw error;
        }
        lastError = error;
      }
      await delay(300 * 2 ** attempt, signal);
    }

    throw lastError;
  }

  async #waitUntilReady({ statusUrl, uploadsPath, uploadId, token, signal, onStatus }) {
    const endpoint = resolveServerUrl(statusUrl, this.baseUrl, `${uploadsPath}/${encodeURIComponent(uploadId)}`);
    const deadline = Date.now() + this.readyTimeout;

    while (Date.now() < deadline) {
      const status = await this.#requestJson(endpoint, {
        method: 'GET',
        headers: this.#authHeaders(token),
        signal,
      });
      onStatus?.(status.status);
      if (status.status === 'ready') return status;
      if (status.status === 'failed' || status.status === 'error') {
        throw new DripFilesError(status.status_message ?? 'DripFiles no pudo finalizar la subida.', { details: status });
      }
      await delay(500, signal);
    }

    throw new DripFilesError('La subida terminó, pero DripFiles tardó demasiado en preparar el enlace.');
  }

  async #requestJson(url, init) {
    const response = await this.#fetch(url, init);
    if (!response.ok) throw await responseError(response, 'La petición a DripFiles ha fallado');
    return parseJsonResponse(response);
  }

  async #fetch(url, init, useTimeout = true) {
    const timeout = useTimeout ? timeoutSignal(init.signal, this.requestTimeout) : { signal: init.signal, cleanup() {} };
    try {
      return await this.fetch(url, { ...init, signal: timeout.signal });
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason ?? error;
      if (timeout.timedOut()) {
        throw new DripFilesError('La conexión con DripFiles agotó el tiempo de espera.', { cause: error });
      }
      if (error instanceof DripFilesError) throw error;
      throw new DripFilesError(`No se pudo conectar con DripFiles: ${error.message}`, { cause: error });
    } finally {
      timeout.cleanup();
    }
  }

  #apiUrl(pathname) {
    return new URL(pathname, `${this.baseUrl}/`).href;
  }

  #authHeaders(uploadToken) {
    if (this.apiKey) return { authorization: `Bearer ${this.apiKey}` };
    return uploadToken ? { 'x-upload-token': uploadToken } : {};
  }
}

async function inspectFiles(inputPaths) {
  const paths = Array.isArray(inputPaths) ? inputPaths : [inputPaths];
  if (paths.length === 0 || paths.some((value) => !value)) {
    throw new DripFilesError('Indica al menos un archivo para subir.');
  }

  return Promise.all(paths.map(async (input) => {
    const path = resolve(String(input));
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new DripFilesError(`No existe: ${path}`, { cause: error });
      throw error;
    }
    if (!info.isFile()) throw new DripFilesError(`No es un archivo: ${path}`);
    if (info.size === 0) throw new DripFilesError(`DripFiles no admite archivos vacíos: ${path}`);
    return { path, name: basename(path), size: info.size };
  }));
}

function createMultipartBody({ file, fileUid, start, end }) {
  const boundary = `----dripfiles-${randomBytes(12).toString('hex')}`;
  const filename = quoteHeaderValue(file.name);
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="files"; filename="${filename}"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n',
  );
  const suffix = Buffer.from(
    `\r\n--${boundary}\r\n` +
    'Content-Disposition: form-data; name="file_uid"\r\n\r\n' +
    `${quoteFieldValue(fileUid)}\r\n` +
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="original_path"\r\n\r\n' +
    `${quoteFieldValue(file.name)}\r\n` +
    `--${boundary}--\r\n`,
  );
  const contentLength = end >= start ? end - start + 1 : 0;

  return {
    boundary,
    length: prefix.length + contentLength + suffix.length,
    stream() {
      return Readable.from((async function* multipartStream() {
        yield prefix;
        if (contentLength > 0) {
          for await (const chunk of createReadStream(file.path, { start, end })) yield chunk;
        }
        yield suffix;
      })());
    },
  };
}

async function resolveDownloadTarget(output, suggestedName) {
  if (!output) return resolve(suggestedName);
  const rawOutput = String(output);
  const target = resolve(rawOutput);
  if (/[\\/]$/.test(rawOutput)) return join(target, suggestedName);
  try {
    if ((await stat(target)).isDirectory()) return join(target, suggestedName);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return target;
}

async function assertMissing(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new DripFilesError(`Ya existe: ${path}. Usa --force para sobrescribirlo.`);
}

function filenameFromDisposition(value) {
  if (!value) return null;
  const encoded = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded.trim().replace(/^"|"$/g, '')); } catch {}
  }
  const quoted = value.match(/filename\s*=\s*"((?:\\.|[^"])*)"/i)?.[1];
  if (quoted) return quoted.replace(/\\(.)/g, '$1');
  return value.match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim() ?? null;
}

function filenameFromUrl(value) {
  try {
    const name = decodeURIComponent(new URL(value).pathname.split('/').filter(Boolean).pop() ?? 'download');
    return name || 'download';
  } catch {
    return 'download';
  }
}

function safeFilename(value) {
  let name = basename(String(value).replaceAll('\\', '/'))
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name && name !== '.' && name !== '..' ? name : 'download';
}

function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new DripFilesError(`URL base no válida: ${value}`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new DripFilesError('La URL base debe usar HTTP o HTTPS.');
  return url.href.replace(/\/+$/, '');
}

function resolveServerUrl(value, baseUrl, fallbackPath) {
  return value ? new URL(value, `${baseUrl}/`).href : new URL(fallbackPath, `${baseUrl}/`).href;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  try {
    const data = text ? JSON.parse(text) : {};
    if (data.ok === false) throw new DripFilesError(apiMessage(data), { status: response.status, details: data });
    return data;
  } catch (error) {
    if (error instanceof DripFilesError) throw error;
    throw new DripFilesError('DripFiles devolvió una respuesta que no es JSON válido.', { status: response.status, details: text });
  }
}

async function responseError(response, fallback) {
  const text = await response.text().catch(() => '');
  let details = text;
  let message = fallback;
  try {
    details = JSON.parse(text);
    message = apiMessage(details) || fallback;
  } catch {
    if (text && text.length < 300 && !/<html/i.test(text)) message = text;
  }
  return new DripFilesError(`${message} (HTTP ${response.status})`, { status: response.status, details });
}

function apiMessage(data) {
  return data?.message ?? data?.error?.message ?? data?.error ?? data?.status_message ?? '';
}

function timeoutSignal(parentSignal, milliseconds) {
  if (!milliseconds || milliseconds <= 0) {
    return { signal: parentSignal, cleanup() {}, timedOut() { return false; } };
  }
  const controller = new AbortController();
  let didTimeOut = false;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new Error('Request timeout'));
  }, milliseconds);
  timer.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

function delay(milliseconds, signal) {
  return new Promise((resolveDelay, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Operación cancelada.'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolveDelay();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal.reason ?? new Error('Operación cancelada.'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function quoteHeaderValue(value) {
  return String(value).replace(/[\r\n]/g, '').replace(/["\\]/g, '_');
}

function quoteFieldValue(value) {
  return String(value).replace(/[\r\n]/g, '');
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}
