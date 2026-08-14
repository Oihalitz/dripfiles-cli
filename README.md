# DripFiles CLI

[![CI](https://github.com/Oihalitz/dripfiles-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Oihalitz/dripfiles-cli/actions/workflows/ci.yml)

Upload and download [DripFiles](https://dripfiles.com) transfers without leaving your terminal. No account or API key is required.

## Installation

```bash
npm install --global dripfiles
dripfiles --help
```

After a global installation, the `dripfiles` command is available on Windows, macOS, and Linux. Running it without arguments displays the help page.

You can also run it without installing it globally:

```bash
npx dripfiles archive.zip
```

The first `npx` run may ask for confirmation before downloading the package. In CI, use `npx --yes dripfiles archive.zip`.

Requires a maintained Node.js release: Node.js 22 or later.

## Quick start

The short form automatically detects what you want to do:

```bash
# A local path is uploaded; stdout contains only the share link
dripfiles video.mp4
# https://dripfiles.com/AbC123

# A URL is downloaded to the current directory
dripfiles https://dripfiles.com/AbC123
# /current/path/video.mp4
```

Upload multiple files in a single transfer:

```bash
dripfiles photos.zip notes.pdf --message "For the team"
```

Use explicit commands when they are clearer in a script:

```bash
dripfiles upload build.tar.gz
dripfiles download AbC123 --output ./downloads/
```

## Use your API key

Connect a DripFiles account interactively:

```bash
dripfiles auth login
dripfiles auth status
dripfiles auth logout
```

The key is validated before it is saved and is stored in the operating system's configuration directory with restricted permissions. Once logged in, uploads automatically use that account's limits and attribution.

For CI or temporary use, provide the key without saving it:

```bash
DRIPFILES_API_KEY="df_..." dripfiles release.zip
DRIPFILES_API_KEY="df_..." dripfiles auth status
```

API keys are not accepted as command-line arguments so they do not appear in shell history or process listings.

## Options

```text
-m, --message <text>     Transfer message
-o, --output <path>      Destination file or directory
-f, --force              Overwrite the destination file
    --json               JSON output for scripts
-q, --quiet              Hide status and progress
    --no-progress        Hide the progress bar
    --base-url <URL>     Use another DripFiles server
-h, --help               Show help
-v, --version            Show the version
```

You can also use `dripfiles help`. The `DRIPFILES_BASE_URL` environment variable is equivalent to `--base-url`.

## Automation

Progress and status messages are written to stderr. During uploads, stdout contains only the share link, so it can be captured directly:

```bash
link="$(dripfiles release.zip)"
printf 'Download: %s\n' "$link"
```

For structured output:

```bash
dripfiles upload release.zip --json
dripfiles download AbC123 --json --output ./release.zip
```

Downloads are first written with a `.part` extension and renamed when complete. Existing files are never overwritten unless you pass `--force`.

## Free API limits

- 2 GB per file.
- 10 GB per transfer.
- Up to 50 files.
- Free links expire after 2 days.

The CLI uses the chunk size advertised by the server and automatically retries temporary failures. When an API key is configured, the connected account's limits are used instead.

## Supported systems

- Windows.
- macOS on Intel and Apple Silicon.
- Linux.

The package does not execute platform-specific commands and has no native dependencies. Downloaded filenames are sanitized to avoid invalid characters and reserved names on Windows.

## Development

```bash
npm test
npm run check
npm pack --dry-run
```

## License

MIT
