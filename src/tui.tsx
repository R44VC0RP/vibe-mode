/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"
import { spawn, type ChildProcess } from "node:child_process"
import { createConnection } from "node:net"

const DEFAULT_URL = "https://www.youtube.com/watch?v=7MLRfIoSbdY&list=RD7MLRfIoSbdY&start_radio=1"
const KV_ENABLED = "vibe-mode.enabled"
const KV_STATION = "vibe-mode.station"

type Station = {
  id: string
  title: string
  subtitle: string
  url: string
  startSeconds?: number
  playlist?: boolean
}

const DEFAULT_STATIONS: Station[] = [
  {
    id: "house",
    title: "House",
    subtitle: "four-on-floor flow",
    url: DEFAULT_URL,
    startSeconds: 412,
  },
  {
    id: "lofi",
    title: "Lo-Fi",
    subtitle: "soft-focus loops",
    url: "https://www.youtube.com/watch?v=1J4a9cT2lkw&list=RD1J4a9cT2lkw&start_radio=1",
  },
  {
    id: "jazz",
    title: "Jazz",
    subtitle: "after-hours debugging",
    url: "https://www.youtube.com/watch?v=oL0eR16-tRs&list=RDoL0eR16-tRs&start_radio=1",
  },
]

type Config = {
  url: string
  station: string
  stations: Station[]
  player: string
  volume: number
  idleVolumeRatio: number
  fadeMs: number
  ytdlFormat: string
  banner: boolean
  startMinSeconds: number
  startMaxSeconds: number
  preResolve: boolean
  prewarm: boolean
  resolveTTLSeconds: number
  resolveTimeoutMs: number
}

type Options = {
  url?: unknown
  station?: unknown
  stations?: unknown
  player?: unknown
  volume?: unknown
  idleVolumeRatio?: unknown
  fadeMs?: unknown
  ytdlFormat?: unknown
  banner?: unknown
  panel?: unknown
  startMinSeconds?: unknown
  startMaxSeconds?: unknown
  preResolve?: unknown
  prewarm?: unknown
  resolveTTLSeconds?: unknown
  resolveTimeoutMs?: unknown
}

type Mode = "stopped" | "starting" | "playing" | "fading" | "error"
type Timer = ReturnType<typeof setTimeout>
type PlayerHandle = {
  child: ChildProcess
  socket: string
  stationID: string
  source: string
}

type CommandCompatApi = TuiPluginApi & {
  keymap?: {
    registerLayer(input: {
      commands: {
        name: string
        title: string
        category: string
        namespace: string
        slashName: string
        run: () => void
      }[]
    }): () => void
  }
  command?: {
    register(
      cb: () => {
        title: string
        value: string
        category: string
        slash: { name: string }
        onSelect: () => void
      }[],
    ): () => void
  }
}

function stringOption(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function numberOption(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

function boolOption(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback
}

function readStation(value: unknown): Station | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  const id = stringOption(input.id, "")
  const title = stringOption(input.title, id)
  const subtitle = stringOption(input.subtitle, "custom station")
  const url = stringOption(input.url, "")
  const startSeconds = numberOption(input.startSeconds, -1, -1, 7200)
  const playlist = boolOption(input.playlist, false)
  if (!id || !url) return
  return {
    id,
    title,
    subtitle,
    url,
    ...(startSeconds >= 0 ? { startSeconds } : {}),
    ...(playlist ? { playlist } : {}),
  }
}

function readStations(value: unknown, fallbackUrl: string) {
  const custom = Array.isArray(value) ? value.map(readStation).filter((item): item is Station => !!item) : []
  const base = [...DEFAULT_STATIONS]
  if (fallbackUrl !== DEFAULT_URL) {
    const { playlist: _playlist, ...house } = base[0]!
    base[0] = { ...house, url: fallbackUrl }
  }

  const byID = new Map(base.map((item) => [item.id, item]))
  for (const item of custom) byID.set(item.id, item)
  return Array.from(byID.values())
}

function readConfig(options: Options | undefined): Config {
  const url = stringOption(options?.url, DEFAULT_URL)
  const stations = readStations(options?.stations, url)
  return {
    url,
    station: stringOption(options?.station, "house"),
    stations,
    player: stringOption(options?.player, "mpv"),
    volume: numberOption(options?.volume, 45, 0, 100),
    idleVolumeRatio: numberOption(options?.idleVolumeRatio, 0.6, 0, 1),
    fadeMs: numberOption(options?.fadeMs, 1800, 0, 10000),
    ytdlFormat: stringOption(options?.ytdlFormat, "bestaudio"),
    banner: boolOption(options?.banner ?? options?.panel, true),
    startMinSeconds: numberOption(options?.startMinSeconds, 300, 0, 3600),
    startMaxSeconds: numberOption(options?.startMaxSeconds, 600, 0, 7200),
    preResolve: boolOption(options?.preResolve, true),
    prewarm: boolOption(options?.prewarm, true),
    resolveTTLSeconds: numberOption(options?.resolveTTLSeconds, 1800, 60, 21600),
    resolveTimeoutMs: numberOption(options?.resolveTimeoutMs, 15000, 1000, 60000),
  }
}

function isRunning(status: { type: string } | undefined) {
  return status?.type === "busy" || status?.type === "retry"
}

function unref(timer: Timer) {
  const fn = (timer as { unref?: () => void }).unref
  if (fn) fn.call(timer)
}

function ipcPath() {
  return `/tmp/opencode-vibe-${process.pid}-${Date.now()}.sock`
}

function stationStartSeconds(config: Config, station: Station) {
  if (typeof station.startSeconds === "number") return station.startSeconds
  const min = Math.min(config.startMinSeconds, config.startMaxSeconds)
  const max = Math.max(config.startMinSeconds, config.startMaxSeconds)
  if (max <= 0) return 0
  return Math.floor(min + Math.random() * (max - min + 1))
}

function registerCommands(
  api: TuiPluginApi,
  toggle: () => void,
  restart: () => void,
  nextStation: () => void,
  previousStation: () => void,
) {
  const compat = api as CommandCompatApi
  if (compat.keymap) {
    compat.keymap.registerLayer({
      commands: [
        {
          name: "vibe.toggle",
          title: "Toggle vibe mode",
          category: "Plugin",
          namespace: "palette",
          slashName: "vibe",
          run: toggle,
        },
        {
          name: "vibe.restart",
          title: "Restart vibe mode player",
          category: "Plugin",
          namespace: "palette",
          slashName: "vibe-restart",
          run: restart,
        },
        {
          name: "vibe.next",
          title: "Next vibe mode station",
          category: "Plugin",
          namespace: "palette",
          slashName: "vibe-next",
          run: nextStation,
        },
        {
          name: "vibe.previous",
          title: "Previous vibe mode station",
          category: "Plugin",
          namespace: "palette",
          slashName: "vibe-prev",
          run: previousStation,
        },
      ],
    })
    return
  }

  const dispose = compat.command?.register(() => [
    {
      title: "Toggle vibe mode",
      value: "vibe.toggle",
      category: "Plugin",
      slash: { name: "vibe" },
      onSelect: toggle,
    },
    {
      title: "Restart vibe mode player",
      value: "vibe.restart",
      category: "Plugin",
      slash: { name: "vibe-restart" },
      onSelect: restart,
    },
    {
      title: "Next vibe mode station",
      value: "vibe.next",
      category: "Plugin",
      slash: { name: "vibe-next" },
      onSelect: nextStation,
    },
    {
      title: "Previous vibe mode station",
      value: "vibe.previous",
      category: "Plugin",
      slash: { name: "vibe-prev" },
      onSelect: previousStation,
    },
  ])
  if (dispose) api.lifecycle.onDispose(dispose)
}

const tui: TuiPlugin = async (api, options) => {
  const config = readConfig(options as Options | undefined)
  const busySessions = new Set<string>()

  let player: PlayerHandle | undefined
  let standby: PlayerHandle | undefined
  let currentVolume = 0
  let fadeTimer: Timer | undefined
  let fadeToken = 0
  let prewarmToken = 0
  let desired = false
  let restartBlocked = false
  let lastProblemToast = ""
  const resolved = new Map<string, { url: string; expires: number }>()
  const resolving = new Map<string, Promise<string>>()

  const [enabled, setEnabledSignal] = createSignal(api.kv.get(KV_ENABLED, true))
  const [stationID, setStationIDSignal] = createSignal(api.kv.get(KV_STATION, config.station))
  const [active, setActive] = createSignal(false)
  const [mode, setMode] = createSignal<Mode>("stopped")
  const [problem, setProblem] = createSignal<string | undefined>()
  const [revision, setRevision] = createSignal(0)

  const stationIndex = () => {
    const hit = config.stations.findIndex((item) => item.id === stationID())
    return hit >= 0 ? hit : Math.max(0, config.stations.findIndex((item) => item.id === config.station))
  }
  const station = () => config.stations[stationIndex()] ?? config.stations[0]!
  const nextStationItem = () => config.stations[(stationIndex() + 1) % config.stations.length]
  const idleVolume = () => Math.round(config.volume * config.idleVolumeRatio)
  const targetVolume = () => (active() ? config.volume : idleVolume())

  const showProblem = (message: string) => {
    setProblem(message)
    setMode("error")
    if (lastProblemToast === message) return
    lastProblemToast = message
    api.ui.toast({
      variant: "error",
      title: "Vibe mode",
      message,
      duration: 5000,
    })
  }

  const clearFade = () => {
    fadeToken += 1
    if (!fadeTimer) return
    clearTimeout(fadeTimer)
    fadeTimer = undefined
  }

  const resolveStationUrl = (item: Station) => {
    if (item.playlist) return Promise.resolve(item.url)
    if (!config.preResolve) return Promise.resolve(item.url)

    const cached = resolved.get(item.id)
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.url)

    const existing = resolving.get(item.id)
    if (existing) return existing

    const task = new Promise<string>((resolve) => {
      let stdout = ""
      let done = false
      const child = spawn("yt-dlp", ["-g", "-f", config.ytdlFormat, "--no-playlist", item.url], {
        stdio: ["ignore", "pipe", "ignore"],
      })
      const timer = setTimeout(() => finish(item.url), config.resolveTimeoutMs)
      unref(timer)

      const finish = (url: string) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolving.delete(item.id)
        if (!child.killed) child.kill("SIGTERM")
        if (url !== item.url) {
          resolved.set(item.id, {
            url,
            expires: Date.now() + config.resolveTTLSeconds * 1000,
          })
        }
        resolve(url)
      }

      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk)
      })
      child.once("error", () => finish(item.url))
      child.once("exit", () => {
        const direct = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.startsWith("http://") || line.startsWith("https://"))
        finish(direct ?? item.url)
      })
    })

    resolving.set(item.id, task)
    return task
  }

  const resolveAllStations = () => {
    if (!config.preResolve) return
    for (const item of config.stations) void resolveStationUrl(item)
  }

  const sendMpv = (command: unknown[], socket = player?.socket) => {
    if (!socket) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const conn = createConnection(socket)
      const timeout = setTimeout(() => finish(false), 250)
      unref(timeout)
      let done = false

      const finish = (ok: boolean) => {
        if (done) return
        done = true
        clearTimeout(timeout)
        conn.destroy()
        resolve(ok)
      }

      conn.once("connect", () => {
        conn.write(`${JSON.stringify({ command })}\n`, () => finish(true))
      })
      conn.once("error", () => finish(false))
    })
  }

  const quitHandle = (handle: PlayerHandle | undefined) => {
    if (!handle) return
    void sendMpv(["quit"], handle.socket)
    const killTimer = setTimeout(() => {
      if (!handle.child.killed) handle.child.kill("SIGTERM")
    }, 300)
    unref(killTimer)
  }

  const terminatePlayer = () => {
    const handle = player
    player = undefined
    currentVolume = 0
    clearFade()
    quitHandle(handle)
  }

  const terminateStandby = () => {
    const handle = standby
    standby = undefined
    quitHandle(handle)
  }

  const fadeTo = (target: number, after?: () => void) => {
    clearFade()
    const token = fadeToken
    const start = currentVolume
    const startAt = Date.now()
    const duration = config.fadeMs

    if (duration === 0) {
      currentVolume = target
      void sendMpv(["set_property", "volume", Math.round(target)])
      after?.()
      return
    }

    const step = () => {
      if (token !== fadeToken) return
      const amount = Math.min(1, (Date.now() - startAt) / duration)
      currentVolume = start + (target - start) * amount
      void sendMpv(["set_property", "volume", Math.round(currentVolume)])

      if (amount >= 1) {
        fadeTimer = undefined
        after?.()
        return
      }

      fadeTimer = setTimeout(step, 100)
      unref(fadeTimer)
    }

    step()
  }

  const spawnPlayer = (input: { item: Station; source: string; volume: number; role: "active" | "standby" }) => {
    const socket = ipcPath()
    const startAt = stationStartSeconds(config, input.item)

    try {
      const child = spawn(
        config.player,
        [
          "--no-video",
          "--force-window=no",
          "--input-terminal=no",
          `--input-ipc-server=${socket}`,
          `--volume=${input.volume}`,
          `--loop-playlist=inf`,
          ...(input.item.playlist ? [`--ytdl-raw-options=yes-playlist=`] : []),
          `--ytdl-format=${config.ytdlFormat}`,
          `--start=${startAt}`,
          "--msg-level=all=warn",
          input.source,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      )

      const handle: PlayerHandle = {
        child,
        socket,
        stationID: input.item.id,
        source: input.source,
      }
      let stderr = ""

      child.stderr?.on("data", (chunk) => {
        stderr = `${stderr}${String(chunk)}`.split(/\r?\n/).slice(-4).join("\n")
      })

      child.once("error", (error) => {
        if (input.role === "active" && player === handle) {
          player = undefined
          restartBlocked = true
          showProblem(`Unable to start ${config.player}: ${error.message}`)
        }
        if (input.role === "standby" && standby === handle) standby = undefined
      })

      child.once("exit", (code) => {
        if (input.role === "standby") {
          if (standby === handle) standby = undefined
          return
        }

        if (player !== handle) return
        player = undefined
        currentVolume = 0
        if (!desired) {
          setMode("stopped")
          return
        }
        if (code === 0) {
          const timer = setTimeout(() => void startPlayer(), 500)
          unref(timer)
          return
        }
        restartBlocked = true
        const detail = stderr.trim() || `${config.player} exited with code ${code ?? "unknown"}`
        showProblem(detail)
      })

      return handle
    } catch (error) {
      if (input.role === "active") {
        player = undefined
        restartBlocked = true
        showProblem(error instanceof Error ? error.message : String(error))
      }
    }
  }

  async function startPlayer() {
    if (player || restartBlocked || !enabled()) return

    const item = station()
    setProblem(undefined)
    setMode("starting")
    const source = await resolveStationUrl(item)
    if (player || restartBlocked || !desired || station().id !== item.id) return

    const handle = spawnPlayer({ item, source, volume: 0, role: "active" })
    if (!handle) return
    player = handle

    fadeTo(targetVolume(), () => {
      if (!desired) return
      setMode("playing")
    })
    void prewarmNext()
  }

  async function prewarmNext() {
    const token = ++prewarmToken
    if (!config.prewarm || !enabled() || config.stations.length < 2) {
      terminateStandby()
      return
    }

    const item = nextStationItem()
    if (!item || item.id === station().id) return
    if (standby?.stationID === item.id) return

    terminateStandby()
    const source = await resolveStationUrl(item)
    if (token !== prewarmToken || !enabled() || item.id === station().id) return

    const handle = spawnPlayer({ item, source, volume: 0, role: "standby" })
    if (token !== prewarmToken || !enabled() || item.id === station().id) {
      quitHandle(handle)
      return
    }
    standby = handle
  }

  const applyDesired = () => {
    const busy = busySessions.size > 0
    const shouldPlay = enabled()
    setActive(busy)
    desired = shouldPlay

    if (shouldPlay) {
      if (mode() === "fading") setMode("playing")
      const alreadyPlaying = !!player
      void startPlayer()
      if (alreadyPlaying && player) fadeTo(targetVolume(), () => setMode("playing"))
      return
    }

    if (!player) {
      terminateStandby()
      setMode(problem() ? "error" : "stopped")
      return
    }

    setMode("fading")
    fadeTo(0, () => {
      terminatePlayer()
      terminateStandby()
      if (!desired) setMode(problem() ? "error" : "stopped")
    })
  }

  const setEnabled = (next: boolean) => {
    api.kv.set(KV_ENABLED, next)
    setEnabledSignal(next)
    if (next) restartBlocked = false
    applyDesired()
  }

  const loadStation = async (item: Station) => {
    if (standby?.stationID === item.id) {
      const previous = player
      player = standby
      standby = undefined
      currentVolume = targetVolume()
      setMode("playing")
      void sendMpv(["set_property", "volume", Math.round(currentVolume)])
      quitHandle(previous)
      void prewarmNext()
      return
    }

    if (!player) {
      void startPlayer()
      return
    }

    setMode("starting")
    const startAt = stationStartSeconds(config, item)
    const source = await resolveStationUrl(item)
    const fileOptions = [`start=${startAt}`, ...(item.playlist ? [`ytdl-raw-options=yes-playlist=`] : [])].join(",")
    const ok = await sendMpv(["loadfile", source, "replace", -1, fileOptions])
    if (!ok) {
      terminatePlayer()
      if (enabled()) void startPlayer()
      return
    }

    fadeTo(targetVolume(), () => {
      if (desired) setMode("playing")
    })
    void prewarmNext()
  }

  const setStation = (id: string) => {
    const next = config.stations.find((item) => item.id === id)
    if (!next || next.id === station().id) return
    api.kv.set(KV_STATION, next.id)
    setStationIDSignal(next.id)
    restartBlocked = false
    setProblem(undefined)

    if (!enabled()) return
    if (!player) {
      applyDesired()
      return
    }
    void loadStation(next)
  }

  const nextStation = () => {
    const index = stationIndex()
    const next = config.stations[(index + 1) % config.stations.length]
    if (next) setStation(next.id)
  }

  const previousStation = () => {
    const index = stationIndex()
    const next = config.stations[(index - 1 + config.stations.length) % config.stations.length]
    if (next) setStation(next.id)
  }

  const refreshStatuses = async () => {
    const result = await api.client.session.status().catch(() => undefined)
    const data = result?.data ?? {}
    busySessions.clear()
    for (const [sessionID, status] of Object.entries(data)) {
      if (isRunning(status)) busySessions.add(sessionID)
    }
    setRevision((value) => value + 1)
    applyDesired()
  }

  api.event.on("session.status", (event) => {
    if (isRunning(event.properties.status)) busySessions.add(event.properties.sessionID)
    else busySessions.delete(event.properties.sessionID)
    setRevision((value) => value + 1)
    applyDesired()
  })

  api.event.on("session.deleted", (event) => {
    busySessions.delete(event.properties.sessionID)
    setRevision((value) => value + 1)
    applyDesired()
  })

  registerCommands(
    api,
    () => {
      setEnabled(!enabled())
      api.ui.toast({
        variant: enabled() ? "success" : "info",
        title: "Vibe mode",
        message: enabled() ? "Background music enabled" : "Background music disabled",
        duration: 2000,
      })
    },
    () => {
      restartBlocked = false
      setProblem(undefined)
      terminatePlayer()
      applyDesired()
    },
    nextStation,
    previousStation,
  )

  const refreshTimer = setInterval(() => void refreshStatuses(), 10000)
  unref(refreshTimer)
  resolveAllStations()
  applyDesired()
  void refreshStatuses()

  api.lifecycle.onDispose(() => {
    clearInterval(refreshTimer)
    busySessions.clear()
    desired = false
    terminatePlayer()
    terminateStandby()
  })

  function VibeLine(props: { api: TuiPluginApi }) {
    const theme = () => props.api.theme.current

    return (
      <text fg={theme().textMuted} onMouseUp={nextStation} wrapMode="none">
        Current Vibe: <span style={{ fg: problem() ? theme().error : active() ? theme().accent : theme().text }}><b>{station().title}</b></span>
      </text>
    )
  }

  api.slots.register({
    order: 900,
    slots: {
      home_prompt_right() {
        if (!config.banner) return null
        return <VibeLine api={api} />
      },
      session_prompt_right() {
        if (!config.banner) return null
        return <VibeLine api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-vibe-mode",
  tui,
}

export default plugin
