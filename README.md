# dsh-phone-agent

**Let your AI agent actually use your Android phone.**

Most "phone automation" needs ADB, a USB cable, or a rooted device. This plugin
takes a different route: the phone runs a small accessibility service, and the
agent talks to it over your local network. The agent reads the screen as a
**node tree** — text, control type, clickability, coordinates — so it can see
what a human sees, then tap, swipe, type and launch apps the same way.

```
   ┌─────────────┐   one JSON request    ┌──────────────────┐
   │  DSH agent  │ ────────────────────► │  DSH-phone app   │
   │  (desktop)  │ ◄──────────────────── │  accessibility   │
   └─────────────┘   one JSON response   │  service, TCP    │
          ▲                              │  8790            │
          │  tools: phone_screen,        └──────────────────┘
          │  phone_click, phone_task …            │
          └───────────────────────────────────────┘
                                          screen → decide → act → confirm
```

## Why this exists

The natural agent loop is **screen → decide → act → screen → confirm**. Done
through a shell — `adb shell input tap 540 1200`, then parse a `uiautomator
dump` — every iteration costs a process spawn, a text-format parser, and a
fragile regex. Done as a tool call, one iteration is one structured request.

Three details that make it usable rather than merely possible:

**Readable node trees.** `phone_screen` returns one line per node with its
`#index`, label, class, clickable/editable/scrollable flags, and centre
coordinates. The model picks an index instead of guessing pixels.

**Waiting instead of sleeping.** `phone_wait` polls for a condition (`text`
appeared, `gone` disappeared, `pkg` foreground) and returns the moment it holds.
A screenshot-then-sleep loop is the usual cause of flaky automation; this
removes it.

**Failures that leave evidence.** `phone_task` runs a whole sequence in one
process, retries transport hiccups, and on failure writes the screenshot plus
the UI tree to disk before stopping. It also returns the phone to the DSH
interface, so the device is never parked mid-flow.

## The phone side

The agent tools are useless without the APK, which is published separately as
[`DSH-phone.apk`](../../releases) (also built from source in the `dsh-phone-app`
directory of the author's workspace).

1. Install the APK on the phone and grant the accessibility permission.
2. Open the app and press **开始保活** (start keep-alive) — without it, the
   system reclaims the process and the agent goes offline.
3. Copy the **pairing token** from the app's 返回键菜单 → 「手机 Agent」 panel.
4. Put the phone's address and that token in `$DSH_HOME/.phone-agent.json`:

```json
{ "host": "192.168.1.20", "token": "<token>", "port": 8790 }
```

The phone and the computer must be on the same network. A phone hotspot with
the computer joined to it works well; so does plain Wi-Fi.

> **On Android 11+ only for screenshots.** `takeScreenshot` needs API 30.
> Every other tool works on older versions.

## Install

```bash
# inside your DSH profile directory
npm install dsh-phone-agent
```

Then add it to the profile's bundle list (`package.json`):

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-phone-agent"]
    }
  }
}
```

Restart DSH. The tools appear as `phone_*` in the agent's toolset.

## Tools

| Tool | What it does |
|---|---|
| `phone_ping` | Is the agent alive? Model, screen size, build, pid, uptime |
| `phone_screen` | Read the node tree (index, label, class, flags, centre) |
| `phone_screenshot` | Save a PNG of the screen |
| `phone_wait` | Wait for text to appear/disappear, or a package to be foreground |
| `phone_click` | Tap by index, by label, or by coordinates; long-press supported |
| `phone_text` | Write text into an input field |
| `phone_swipe` | Swipe, with optional path shaping |
| `phone_key` | back / home / recents / notifications |
| `phone_apps` | List launchable apps |
| `phone_open` | Launch an app by package or label |
| `phone_task` | Run a whole step sequence, one process, with a report |

### `phone_screen` vs `phone_screenshot`

| | What you get | Use it for |
|---|---|---|
| `phone_screen` | Control tree: text, indices, clickability | Finding something to tap |
| `phone_screenshot` | PNG pixels | Images, colour, games, captchas |

Indices are valid for **one** read. After the screen changes, read again — a
stale index taps the wrong thing.

### `phone_task`

For "describe it, walk away, come back to a report":

```json
{
  "name": "send a message",
  "steps": [
    { "op": "open", "name": "微信" },
    { "op": "wait", "pkg": "com.tencent.mm" },
    { "op": "click", "text": "搜索" },
    { "op": "text", "value": "妈妈" },
    { "op": "wait", "text": "妈妈" },
    { "op": "click", "text": "妈妈" },
    { "op": "text", "value": "到家了" },
    { "op": "click", "text": "发送" },
    { "op": "assertText", "text": "发送" },
    { "op": "shot", "path": "done.png" }
  ]
}
```

Ops: `open`, `click`, `longclick`, `text`, `swipe`, `key`, `wait`, `assertText`,
`screen`, `shot`, `sleep`, plus `optional: true` on any step to continue past a
failure.

Adjacent steps whose target is already known are **merged into a single
request** — measured at ~270 ms of fixed overhead per step, so a ten-step task
saves 2–3 seconds. Steps that need to see the screen first are never merged:
that read-then-decide step is where the model's reasoning lives.

## Configuration

Any field can come from four places; the first hit wins per field:

| Order | Source |
|---|---|
| 1 | plugin config in `cordis.patch.yml` |
| 2 | `DSH_PHONE_HOST` / `DSH_PHONE_TOKEN` / `DSH_PHONE_PORT` |
| 3 | `$DSH_HOME/.phone-agent.json` |
| 4 | `./.phone-agent.json` |

Prefer the credentials file over inline YAML: it keeps the token out of config
you might commit.

**The token grants control of the phone.** It is read from disk at call time,
never logged, never echoed in an error, and requests only ever go to the
configured host — no tool argument can redirect them.

## CLI, without an agent

Every tool has a CLI equivalent, which is useful for debugging:

```bash
node vendor/phone-task.mjs task.json          # run a task file
node vendor/phone-task.mjs --inline '{"steps":[{"op":"screen"}]}'
```

Task output — screenshots, failure trees, logs — lands in `./phone-tasks/<timestamp>/`
under the **current directory**, never inside the package.

## Development

```bash
npm test          # 27 offline tests, no phone needed
npm run smoke     # against a real device (needs credentials)
```

The test suite is deliberately offline. A test that needs a real device is a
test nobody runs, so the pieces covered here are the ones that actually break —
the URL a request ends up on, how a failure is phrased, whether the renderer
keeps the index, whether the escaping round-trips.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Cannot reach the phone" | Screen off, keep-alive stopped, or accessibility killed | Wake the phone, restart keep-alive |
| "Token rejected" | Token reset by the app | Copy a fresh one |
| `phone_screen` shows no nodes | WebView not exposing content, or a transparent surface | Use `phone_screenshot` instead |
| Screenshot returns nothing | Android < 11, or permission denied | Not supported below API 30 |
| `phone_task` cannot find the runner | Incomplete install | Reinstall; `vendor/phone-task.mjs` must exist |

## Compatibility

| DSH release | Status |
|---|---|
| `0.2.1-rc.2` | compatible |

The phone APK and the plugin talk a fixed JSON protocol; the plugin's
`lib/transport.js` is the only file that knows it.

## License

MIT. See [LICENSE](LICENSE).
