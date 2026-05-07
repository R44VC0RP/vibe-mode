# opencode-vibe-mode

OpenCode TUI plugin that plays background radio while you work. It keeps music on at a lower cruise volume, then fades up when an agent is running.

## Installation

### 1. Install audio dependencies

`opencode-vibe-mode` shells out to `mpv` for playback. `mpv` uses `yt-dlp` to resolve YouTube streams, so both binaries need to be available on your `PATH`.

macOS:

```sh
brew install mpv yt-dlp
```

Linux:

```sh
# Debian/Ubuntu
sudo apt install mpv yt-dlp

# Arch
sudo pacman -S mpv yt-dlp
```

Verify:

```sh
mpv --version
yt-dlp --version
```

### 2. Install plugin dependencies

From this repo:

```sh
bun install
```

### 3. Add the plugin to OpenCode

Local project install:

```sh
opencode plugin /Users/ryanvogel/dev/oc-plugins/vibe-mode
```

Global install:

```sh
opencode plugin -g /Users/ryanvogel/dev/oc-plugins/vibe-mode
```

Restart `opencode` after installing.

## Manual Config

If you want to customize options, add the plugin to your project or global TUI config manually:

```jsonc
// .opencode/tui.json or ~/.config/opencode/tui.json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "file:///Users/ryanvogel/dev/oc-plugins/vibe-mode/src/tui.tsx",
      {
        "station": "house",
        "volume": 45,
        "idleVolumeRatio": 0.6,
        "fadeMs": 1800,
        "banner": true
      }
    ]
  ]
}
```

Restart `opencode` after editing `tui.json`.

## Commands

- `/vibe` toggles background audio on or off.
- `/vibe-restart` restarts `mpv` after installing dependencies or changing audio state.
- `/vibe-next` switches to the next station.
- `/vibe-prev` switches to the previous station.

The Vibe preview is a single right-aligned prompt metadata item. Click `Current Vibe` to jump to the next station, or use the station commands.

## Stations

Built-in stations:

- `house`: the default station using `https://www.youtube.com/watch?v=7MLRfIoSbdY&list=RD7MLRfIoSbdY&start_radio=1`, fixed to start at `6:52`
- `lofi`: soft-focus loops using `https://www.youtube.com/watch?v=1J4a9cT2lkw&list=RD1J4a9cT2lkw&start_radio=1`
- `jazz`: after-hours debugging using `https://www.youtube.com/watch?v=oL0eR16-tRs&list=RDoL0eR16-tRs&start_radio=1`

Custom stations can be configured in `tui.json`:

```jsonc
{
  "plugin": [
    [
      "/Users/ryanvogel/dev/oc-plugins/vibe-mode",
      {
        "station": "house",
        "stations": [
          {
            "id": "house",
            "title": "House",
            "subtitle": "four-on-floor flow",
            "url": "https://www.youtube.com/watch?v=7MLRfIoSbdY&list=RD7MLRfIoSbdY&start_radio=1",
            "startSeconds": 412
          },
          {
            "id": "ambient",
            "title": "Ambient",
            "subtitle": "low-gravity focus",
            "url": "https://www.youtube.com/watch?v=YOUR_VIDEO_ID"
          }
        ]
      }
    ]
  ]
}
```

## Options

- `station`: Station id to start on. Defaults to `house`.
- `stations`: Custom station list. Items need `id`, `title`, `subtitle`, and `url`. Add optional `startSeconds` for a fixed start point.
- `url`: Backward-compatible override for the default `house` station URL.
- `player`: Player binary. Defaults to `mpv`.
- `volume`: Active agent volume from `0` to `100`. Defaults to `45`.
- `idleVolumeRatio`: Idle volume as a ratio of `volume`. Defaults to `0.6`.
- `fadeMs`: Fade duration in milliseconds. Defaults to `1800`.
- `ytdlFormat`: mpv/yt-dlp format. Defaults to `bestaudio`.
- `banner`: Show the right-aligned `Current Vibe` prompt metadata. Defaults to `true`.
- `startMinSeconds`: Minimum station start offset in seconds. Defaults to `300`.
- `startMaxSeconds`: Maximum station start offset in seconds. Defaults to `600`.
- `preResolve`: Resolve YouTube stations to direct audio URLs in the background. Defaults to `true`.
- `prewarm`: Keep the next station loaded in a muted standby player for faster switching. Defaults to `true`.
- `resolveTTLSeconds`: How long direct audio URLs stay cached. Defaults to `1800`.
- `resolveTimeoutMs`: Max time to wait for `yt-dlp -g` before falling back to the original URL. Defaults to `15000`.

Each station start uses a random offset between `startMinSeconds` and `startMaxSeconds`, so switching stations jumps roughly 5-10 minutes into the track. Stations with `startSeconds` use that fixed offset instead.

For faster switching, the plugin pre-resolves station URLs with `yt-dlp -g` and keeps the next station preloaded at volume `0` in a standby `mpv` process. Switching to the prewarmed station promotes that player immediately, then warms the following station.

## Notes

This is a TUI plugin, so it runs only while the OpenCode TUI is open. For headless `opencode run` audio, create a separate server plugin that listens to `session.status` events and uses the same player process approach.
