import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { DEFAULT_BASE_URL, DripFilesClient, DripFilesError, VERSION } from './client.js';
import { clearConfig, configPath, readConfig, saveConfig } from './config.js';

const HELP = `DripFiles from your terminal

Usage:
  dripfiles <file> [more files]            Upload and return a share link
  dripfiles <URL>                          Download to the current directory
  dripfiles upload <file...>               Upload one or more files
  dripfiles download <URL|ID>              Download a DripFiles transfer
  dripfiles auth login                     Save and validate your API key
  dripfiles auth status                    Show the connected account
  dripfiles auth logout                    Remove the saved API key

Options:
  -m, --message <text>     Transfer message
  -o, --output <path>      Destination file or directory
  -f, --force              Overwrite the destination file
      --json               JSON output for scripts
  -q, --quiet              Hide status and progress
      --no-progress        Hide the progress bar
      --base-url <URL>     DripFiles server (default: ${DEFAULT_BASE_URL})
  -h, --help               Show this help
  -v, --version            Show the version

Examples:
  dripfiles video.mp4
  dripfiles photos.zip notes.pdf --message "For the team"
  dripfiles https://dripfiles.com/AbC123
  dripfiles download AbC123 -o ./downloads/
  dripfiles auth login

Environment:
  DRIPFILES_API_KEY       API key for CI or temporary use
  DRIPFILES_BASE_URL      Alternative DripFiles server

For security, API keys are not accepted as command-line arguments.`;

export class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export async function run(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();
  const parsed = parseArguments(argv);

  if (parsed.help || argv.length === 0) {
    stdout.write(`${HELP}\n`);
    return;
  }
  if (parsed.version) {
    stdout.write(`${VERSION}\n`);
    return;
  }

  const controller = new AbortController();
  const onInterrupt = () => controller.abort(new Error('Operation canceled.'));
  process.once('SIGINT', onInterrupt);

  try {
    const command = await resolveCommand(parsed, cwd);
    validateOptions(command, parsed);
    const configOptions = { path: io.configPath };
    const isLogout = command === 'auth' && parsed.inputs[0] === 'logout';
    const storedConfig = isLogout ? {} : (io.config ?? await readConfig(configOptions));
    const baseUrl = parsed.baseUrlExplicit ? parsed.baseUrl : (storedConfig.baseUrl ?? parsed.baseUrl);
    const environmentApiKey = String(process.env.DRIPFILES_API_KEY ?? '').trim();
    const apiKey = environmentApiKey || String(storedConfig.apiKey ?? '').trim();
    const createClient = io.createClient ?? ((options) => new DripFilesClient(options));

    if (command === 'auth') {
      return await handleAuth({
        parsed,
        stdout,
        stderr,
        stdin: io.stdin ?? process.stdin,
        signal: controller.signal,
        baseUrl,
        apiKey,
        environmentApiKey,
        storedConfig,
        configOptions,
        createClient,
        readApiKey: io.readApiKey,
      });
    }

    const client = io.client ?? createClient({ baseUrl, apiKey });
    const quiet = parsed.quiet || parsed.json;
    const progress = createProgress(stderr, { enabled: !quiet && parsed.progress });

    if (command === 'upload') {
      if (!quiet) stderr.write(`Uploading ${plural(parsed.inputs.length, 'file', 'files')}...\n`);
      const result = await client.upload(parsed.inputs.map((item) => resolve(cwd, item)), {
        message: parsed.message,
        signal: controller.signal,
        onProgress: (state) => progress.update('Uploading', state.transferred, state.total),
        onStatus: () => progress.indeterminate('Preparing link'),
      });
      progress.stop();
      stdout.write(parsed.json ? `${JSON.stringify(result)}\n` : `${result.url}\n`);
      return result;
    }

    if (!quiet) stderr.write('Downloading...\n');
    const result = await client.download(parsed.inputs[0], {
      output: parsed.output ? resolveOutput(cwd, parsed.output) : cwd,
      force: parsed.force,
      signal: controller.signal,
      onProgress: (state) => progress.update('Downloading', state.transferred, state.total),
    });
    progress.stop();
    stdout.write(parsed.json ? `${JSON.stringify(result)}\n` : `${result.path}\n`);
    return result;
  } catch (error) {
    if (error instanceof CliUsageError) {
      error.message = `${error.message}\nRun "dripfiles --help" for examples.`;
    }
    if (error?.name === 'AbortError') throw new DripFilesError('Operation canceled.', { cause: error });
    throw error;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
}

export function parseArguments(argv) {
  const result = {
    command: null,
    inputs: [],
    message: '',
    output: null,
    force: false,
    json: false,
    quiet: false,
    progress: true,
    baseUrl: process.env.DRIPFILES_BASE_URL ?? DEFAULT_BASE_URL,
    baseUrlExplicit: Boolean(process.env.DRIPFILES_BASE_URL),
    help: false,
    version: false,
  };
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (positionalOnly) {
      result.inputs.push(argument);
      continue;
    }
    if (argument === '--') {
      positionalOnly = true;
      continue;
    }
    if (argument === 'help' && !result.command && result.inputs.length === 0) {
      result.help = true;
      continue;
    }
    if ((argument === 'upload' || argument === 'download' || argument === 'auth') && !result.command && result.inputs.length === 0) {
      result.command = argument;
      continue;
    }
    if (argument === '-h' || argument === '--help') result.help = true;
    else if (argument === '-v' || argument === '--version') result.version = true;
    else if (argument === '-f' || argument === '--force') result.force = true;
    else if (argument === '--json') result.json = true;
    else if (argument === '-q' || argument === '--quiet') result.quiet = true;
    else if (argument === '--no-progress') result.progress = false;
    else if (argument === '-m' || argument === '--message') result.message = optionValue(argv, ++index, argument);
    else if (argument.startsWith('--message=')) result.message = argument.slice('--message='.length);
    else if (argument === '-o' || argument === '--output') result.output = optionValue(argv, ++index, argument);
    else if (argument.startsWith('--output=')) result.output = argument.slice('--output='.length);
    else if (argument === '--base-url') {
      result.baseUrl = optionValue(argv, ++index, argument);
      result.baseUrlExplicit = true;
    }
    else if (argument.startsWith('--base-url=')) {
      result.baseUrl = argument.slice('--base-url='.length);
      result.baseUrlExplicit = true;
    }
    else if (argument.startsWith('-')) throw new CliUsageError(`Unknown option: ${argument}`);
    else result.inputs.push(argument);
  }

  return result;
}

async function resolveCommand(parsed, cwd) {
  if (parsed.command) {
    if (parsed.command === 'auth') {
      if (parsed.inputs.length === 0) throw new CliUsageError('Missing auth command: login, status, or logout.');
      return 'auth';
    }
    if (parsed.inputs.length === 0) throw new CliUsageError(`Missing ${parsed.command === 'upload' ? 'file' : 'URL'}.`);
    return parsed.command;
  }
  if (parsed.inputs.length === 0) throw new CliUsageError('Missing a file or URL.');
  if (/^https?:\/\//i.test(parsed.inputs[0])) {
    if (parsed.inputs.length > 1) throw new CliUsageError('Only one URL can be downloaded at a time.');
    return 'download';
  }

  try {
    await stat(resolve(cwd, parsed.inputs[0]));
    return 'upload';
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    throw new CliUsageError(`File not found: ${parsed.inputs[0]}`);
  }
}

function validateOptions(command, parsed) {
  if (command === 'auth') {
    if (parsed.inputs.length !== 1 || !['login', 'status', 'logout'].includes(parsed.inputs[0])) {
      throw new CliUsageError('Invalid auth command. Use login, status, or logout.');
    }
    if (parsed.output || parsed.force || parsed.message) {
      throw new CliUsageError('Transfer options cannot be used with auth.');
    }
    return;
  }
  if (command === 'download' && parsed.inputs.length !== 1) {
    throw new CliUsageError('Only one transfer can be downloaded at a time.');
  }
  if (command === 'upload' && parsed.output) throw new CliUsageError('--output can only be used when downloading.');
  if (command === 'upload' && parsed.force) throw new CliUsageError('--force can only be used when downloading.');
  if (command === 'download' && parsed.message) throw new CliUsageError('--message can only be used when uploading.');
}

function optionValue(argv, index, option) {
  const value = argv[index];
  if (value === undefined || value === '') throw new CliUsageError(`Missing value for ${option}.`);
  return value;
}

async function handleAuth(context) {
  const {
    parsed,
    stdout,
    stderr,
    stdin,
    signal,
    baseUrl,
    environmentApiKey,
    storedConfig,
    configOptions,
    createClient,
    readApiKey,
  } = context;
  const action = parsed.inputs[0];
  const resolvedConfigPath = configOptions.path ?? configPath();

  if (action === 'logout') {
    await clearConfig(configOptions);
    const result = {
      authenticated: Boolean(environmentApiKey),
      source: environmentApiKey ? 'environment' : null,
      configPath: resolvedConfigPath,
    };
    if (parsed.json) stdout.write(`${JSON.stringify(result)}\n`);
    else if (environmentApiKey) {
      stdout.write('Local API key removed. DRIPFILES_API_KEY is still active in the environment.\n');
    } else {
      stdout.write('API key removed.\n');
    }
    return result;
  }

  if (action === 'login') {
    const prompt = readApiKey ?? (() => readSecret('API key: ', { stdin, stderr }));
    const key = environmentApiKey || String(await prompt()).trim();
    if (!key) throw new CliUsageError('The API key cannot be empty.');
    const client = createClient({ baseUrl, apiKey: key });
    const account = await client.me({ signal });
    const path = await saveConfig({ ...storedConfig, apiKey: key, baseUrl }, configOptions);
    const result = { authenticated: true, source: 'config', baseUrl, configPath: path, account };
    if (parsed.json) stdout.write(`${JSON.stringify(result)}\n`);
    else stdout.write(`API key saved. ${accountSummary(account)}\n`);
    return result;
  }

  const key = context.apiKey;
  if (!key) throw new DripFilesError('No API key is configured. Run "dripfiles auth login".');
  const client = createClient({ baseUrl, apiKey: key });
  const account = await client.me({ signal });
  const result = {
    authenticated: true,
    source: environmentApiKey ? 'environment' : 'config',
    baseUrl,
    account,
  };
  if (parsed.json) stdout.write(`${JSON.stringify(result)}\n`);
  else stdout.write(`${accountSummary(account)}\nSource: ${result.source === 'environment' ? 'DRIPFILES_API_KEY' : resolvedConfigPath}\n`);
  return result;
}

function accountSummary(account) {
  const identity = account.email || `user ${account.user_id ?? 'unknown'}`;
  const tier = account.tier_label || account.plan_name || account.tier || 'unknown plan';
  return `Connected as ${identity} · ${tier}`;
}

function readSecret(prompt, { stdin, stderr }) {
  if (!stdin.isTTY || !stderr.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new CliUsageError('Interactive login requires a terminal. You can also set DRIPFILES_API_KEY.');
  }
  stderr.write(prompt);
  const wasRaw = Boolean(stdin.isRaw);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((resolveSecret, reject) => {
    let value = '';
    const finish = (error) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stderr.write('\n');
      if (error) reject(error);
      else resolveSecret(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') return finish(new Error('Operation canceled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stderr.write('\b \b');
          }
        } else if (character >= ' ') {
          value += character;
          stderr.write('•');
        }
      }
    };
    stdin.on('data', onData);
  });
}

function createProgress(stream, options) {
  const interactive = Boolean(options.enabled && stream.isTTY);
  let visible = false;
  let lastLength = 0;

  function render(line) {
    if (!interactive) return;
    const padded = line.padEnd(lastLength, ' ');
    lastLength = line.length;
    stream.write(`\r${padded}`);
    visible = true;
  }

  return {
    update(label, transferred, total) {
      const percentage = total > 0 ? Math.min(100, Math.floor((transferred / total) * 100)) : 100;
      const width = 22;
      const complete = Math.round((percentage / 100) * width);
      const bar = `${'█'.repeat(complete)}${'░'.repeat(width - complete)}`;
      const amount = total === undefined ? formatBytes(transferred) : `${formatBytes(transferred)} / ${formatBytes(total)}`;
      render(`${label} [${bar}] ${String(percentage).padStart(3)}%  ${amount}`);
    },
    indeterminate(label) {
      render(`${label}...`);
    },
    stop() {
      if (visible) stream.write('\n');
      visible = false;
    },
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function plural(count, singular, pluralValue) {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function resolveOutput(cwd, output) {
  const path = resolve(cwd, output);
  return /[\\/]$/.test(output) ? `${path}${sep}` : path;
}
