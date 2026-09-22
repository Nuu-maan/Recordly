# Recordly MCP

A standalone Node.js MCP server that lets an agent record through the Recordly desktop app. It runs over stdio and connects to Recordly's authenticated local automation API. The desktop app owns capture, permissions, cursor telemetry, audio, saving, and the editor.

Requires Node.js 22+ and a Recordly build that includes the automation API. This package can be copied and installed separately from the desktop source tree. It is not published to npm yet.

## Run from this repository

Install the standalone server's dependencies once:

```bash
npm ci --prefix mcp --ignore-scripts
```

Start Recordly with automation enabled. From the repository root on Linux or macOS:

```bash
RECORDLY_AUTOMATION=1 \
RECORDLY_AUTOMATION_FILE="$PWD/.tmp/automation.json" \
npm run dev
```

In another terminal, start the MCP process:

```bash
node mcp/src/cli.mjs --connection "$PWD/.tmp/automation.json"
```

The MCP process waits for protocol messages on stdin. Usually your agent client launches it using the configuration below. `npm run mcp -- --connection /absolute/path/automation.json` is an equivalent convenience command.

For a packaged Recordly build, fully quit the app first, then launch its executable with:

```bash
recordly --enable-automation --automation-connection-file=/absolute/path/automation.json
```

Use the executable path for your installation (`Recordly.exe` on Windows or `/Applications/Recordly.app/Contents/MacOS/Recordly` on macOS). In PowerShell, the development environment can be set with:

```powershell
$env:RECORDLY_AUTOMATION = "1"
$env:RECORDLY_AUTOMATION_FILE = "$PWD\.tmp\automation.json"
npm run dev
```

The app creates the connection file on startup. Without an explicit file path it uses `automation.json` in Electron's app user-data directory and logs its location. Use an absolute path in your own user directory. The file contains a random authentication token; do not commit it or share it. On Unix it is created with mode `0600`.

## Configure an agent client

For clients accepting an `mcpServers` JSON configuration:

```json
{
  "mcpServers": {
    "recordly": {
      "command": "node",
      "args": [
        "/absolute/path/Recordly/mcp/src/cli.mjs",
        "--connection",
        "/absolute/path/Recordly/.tmp/automation.json"
      ]
    }
  }
}
```

Use an absolute Node executable path if the client does not inherit your shell's PATH. Alternatively, set `RECORDLY_CONNECTION_FILE` in the MCP process's environment. The server can start and list its tools while Recordly is closed; tool calls report that the app is unavailable until its connection file becomes usable. Credentials are re-read on each call, so the MCP process can reconnect after Recordly restarts.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `list_sources` | `{}` | Screen/window IDs, display names, selection requirements, and current capture settings |
| `start_recording` | `requestId`, `sourceId` | A recording ID and `starting` phase |
| `get_recording_status` | Optional `recordingId` | The specified or most recent automation recording, or `idle` |
| `stop_recording` | `recordingId` | `finalizing`, or the existing terminal result on retries |

An example agent workflow:

1. Call `list_sources` and choose the requested screen or window.
2. Call `start_recording` with that `sourceId` and a fresh UUID as `requestId`.
3. The user approves recording in Recordly. Poll `get_recording_status` until `phase` is `recording` before beginning the demonstration.
4. Perform the demonstration using the agent's existing browser or computer controls.
5. Call `stop_recording`, then poll until `completed`, `failed`, or `cancelled`.
6. A completed result contains `videoPath` and optionally `webcamPath`.

Example start arguments:

```json
{
  "requestId": "01c25e2a-4dac-4520-bb83-23dfebca5b3e",
  "sourceId": "screen:1:0"
}
```

Use a real source ID returned by `list_sources`. Reuse the same request ID when retrying the same start. It becomes the recording ID. Reusing an ID with a different source is rejected. The desktop app retains the most recent 100 automation recordings in memory until it exits. Old IDs may expire; generate a new UUID for each new recording.

Capture uses the microphone, system audio, webcam, devices, and countdown already configured in Recordly. The approval dialog shows which inputs are enabled. OS permission dialogs and Wayland's screen picker still require user interaction. On Wayland, use `screen:linux-portal` when appropriate; the final surface is chosen in the OS picker. The user can pause, resume, stop, or cancel using Recordly's normal controls. Status includes `paused` while recording.

`completed` is reported after background media finalization. Check any `warnings` for unavailable audio or webcam tracks. The returned video is the source capture; editor effects and polished MP4/GIF exports are separate. No media is uploaded by this integration. Recording continues if the MCP process disconnects; use the desktop controls or reconnect and query its status. A failed result may include a recoverable `videoPath`.

## Architecture and limits

```text
Agent → MCP stdio process → authenticated HTTP on 127.0.0.1
      → Electron recording controller → trusted HUD IPC → existing recording workflow
```

The MCP package has no Electron imports or native capture dependencies. Recordly's API has no MCP SDK dependency. New recording capabilities can be added to the versioned control contract and exposed as tools without duplicating capture implementations.

Recordly supports one capture at a time. Multiple MCP processes can connect to the same app; concurrent starts are rejected, and stop requires a known automation recording ID. Manual recordings cannot be stopped by these tools. The API binds an ephemeral loopback port, requires a per-launch token, rejects browser origins and unexpected Host headers, and limits command bodies and pending requests. Each automated start requires visible approval; automation is disabled unless explicitly enabled at app startup.

The local API is `POST /v1/command` with `Authorization: Bearer <token>` and `Content-Type: application/json`. Its body is `{ "method": "tool_name", "params": { ... } }`. Responses contain `result` or an `error` with `code` and `message`. The connection file's `apiVersion` is checked by the MCP client. Do not expose this API through a public proxy.

## Troubleshooting

- **Connection file missing:** Start an updated Recordly build with automation enabled. Ensure the app and MCP process use the same absolute connection-file path.
- **Connection file already exists:** Another instance may own it. If Recordly crashed, confirm that instance has exited, remove the stale file, then restart. The app deliberately refuses to overwrite an existing connection file. Normal app shutdown removes it.
- **Starting for too long:** Check the approval dialog and OS permission/selection dialogs. An unanswered start times out after three minutes. A timed-out approval cannot later start capture.
- **Source unavailable:** List sources again; window IDs can change when windows close or reopen.
- **Recording failed:** Read its status error and check Recordly. A window closing or renderer failure can interrupt capture. Use the editor's recovery facilities for available media.

## Development checks

```bash
npx tsc --noEmit
npx vitest run electron/automation src/hooks/recordingAutomation.test.ts
npm --prefix mcp test

# Linux desktop + ffprobe, after npx vite build:
npm run smoke:mcp
```

The MCP test launches the actual standalone process and speaks MCP over stdio against a local test API. Desktop tests cover lifecycle, retries, approval, and local API access. The Linux smoke launches an isolated Electron profile, substitutes an animated canvas for screen/camera capture, automatically approves only its test recording dialog, and checks the encoded output with `ffprobe`. It does not capture the real desktop. Native backend and real portal verification is tracked in [issue #3](https://github.com/Nuu-maan/Recordly/issues/3).

To prepare a standalone archive locally, run `npm pack` inside `mcp/`. The package is marked private to prevent accidental registry publication.
