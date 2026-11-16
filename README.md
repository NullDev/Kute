![GitHub Downloads](https://img.shields.io/github/downloads/NullDev/Kute/total?label=Downloads) [![License](https://img.shields.io/github/license/NullDev/Kute?label=License&logo=Creative%20Commons)](https://github.com/NullDev/Kute/blob/master/LICENSE) [![Latest Release](https://img.shields.io/github/v/release/NullDev/Kute?style=flat&label=Latest)](https://github.com/NullDev/Kute/releases/latest) [![release](https://github.com/NullDev/Kute/actions/workflows/release.yml/badge.svg)](https://github.com/NullDev/Kute/actions/workflows/release.yml) [![Server Deploy](https://github.com/NullDev/Kute/actions/workflows/deploy-server.yml/badge.svg)](https://github.com/NullDev/Kute/actions/workflows/deploy-server.yml) [![GitHub closed issues](https://img.shields.io/github/issues-closed-raw/NullDev/Kute?logo=Cachet)](https://github.com/NullDev/Kute/issues?q=is%3Aissue+is%3Aclosed)

<p align="center"><img height="250" width="auto" src="/resources/icon.png" /></p>
<p align="center"><b>A high-performance Krunker client with enhanced features - made by <code>[cute]</code></b><br><a href="https://kute.lol">https://kute.lol</a></p>
<hr>

## :arrow_down: Download

- [Download the latest installer](https://github.com/NullDev/Kute/releases/latest/download/kute-setup-x86_64.msi)
- [Download for Linux (AppImage)](https://github.com/NullDev/Kute/releases/latest/download/kute-x86_64.AppImage) (`chmod +x kute-x86_64.AppImage`, then start it. Settings stay in `~/.config/kute`, it updates itself, see the Linux question in the FAQ below)
- [Download the portable zip](https://github.com/NullDev/Kute/releases/latest/download/kute-x86_64-portable.zip) (unpack anywhere and start `kute.exe`. Settings stay in `Documents\kute`, small updates still apply by themselves, a new client version opens the download page instead of installing)
- [Release notes](https://github.com/NullDev/Kute/releases/latest)
- [All Releases](https://github.com/NullDev/Kute/releases)

<hr>

## :sparkles: About

Kute is a high-performance Krunker client designed to enhance your gaming experience with features like uncapped FPS, optimized performance tweaks, custom scripts, and more. It runs on its own bundled Chromium (CEF) and provides a seamless, feature-rich environment for both casual and competitive players. Brought to you by <code>[cute]</code>, and the same guy who co-developed [idkr](https://github.com/idkr-client/idkr) and contributed to [glorp](https://github.com/slavcp/glorp).

> [!WARNING]
> This client uses patched CEF with Raw Input, which means mouse input is native: every bit of movement reaches the game, more accurately than on any other client. If you are used to playing on other clients, it might take a bit of time to get used to it.

<hr>

## :star: Features

- [x] Runs on its own bundled, patched Chromium (CEF): fixes the aim freeze and the stutter of uncapped clients
- [x] Uncapped FPS with a DXGI present hook and an exact FPS limiter inside Chromium's compositor
- [x] **Proper** Raw input (100%)
- [x] Auto-Detect Best Settings: benchmarks your PC and only keeps what measurably runs better
- [x] Faster lobby changes: Krunker's scripts stay cached
- [x] Laptop support: hybrid graphics detection and Power Boost
- [x] Resource swapper, userscripts (Crankshaft and idkr formats) and CSS manager, each with an in-client manager
- [x] Matchmaker with filters and real pings in Find Game
- [x] Queue ranked without the game open, ranked match alert, rank progress with ELO
- [x] Encrypted Account Manager
- [x] HUD editor, keystrokes, better chat and chat logs
- [x] Classic menu, cleaner menu, Kute CSS, motion blur, custom sky, Kute icons
- [x] OBS capture plugin, officially supported by Medal.tv
- [x] Discord Rich Presence
- [x] Autoupdater, diagnostics report, safe mode and crash finder
- [x] Every feature and every Chromium patch is a setting you can turn off
- [x] Spotify overlay - by [@Liamoulee](https://github.com/Liamoulee)
- [x] and more: [the full list is on the website](https://kute.lol/#features)

<hr>

<p align="center">
If you want to support this Project, you can help with Code contributions :octocat: or a donation ❇️ <br> <br>
<a href="https://ko-fi.com/null_dev"><img src="https://ko-fi.com/img/githubbutton_sm.svg"></a>
</p>

<hr>

## :question: FAQ

<details>
<summary><b>My game stutters.</b></summary>
<br>

Run **Auto-Detect Best Settings** (General settings). It tests the client and plays a private test match by itself (don't touch mouse or keyboard for about two minutes), and only keeps what measurably runs better on your PC (it needs a Krunker account). Leave CPU Throttling at 1. Still stuttering? Save a **Diagnostics Report** (About settings) and attach it to [an issue](https://github.com/NullDev/Kute/issues/choose).

</details>

<details>
<summary><b>I can't aim / my aim feels different.</b></summary>
<br>

Kute uses pure raw input: your mouse's movement goes straight to the game, without Windows pointer acceleration, and none of it gets lost, not even the movement in the same instant as a click or a scroll. No other client passes every bit of it through. It is more accurate, and exactly because of that it can feel different for a few rounds if your aim is used to another client. Give it some time before you change your sensitivity.

</details>

<details>
<summary><b>Does Kute run on Linux?</b></summary>
<br>

Yes, as an [AppImage](https://github.com/NullDev/Kute/releases/latest/download/kute-x86_64.AppImage) for 64-bit Linux with glibc 2.35 or newer (Ubuntu 22.04, Debian 12, Fedora 36 and later, Arch). Make it executable and start it, nothing gets installed. A few things work differently there:

- It runs through X11 (XWayland in a Wayland session) by default, which runs much faster than native Wayland for now. Advanced settings, Display Server switches it.
- Linux applies your desktop's mouse acceleration to the game, Chromium has no raw input there yet. For raw input set your mouse to the **Flat** acceleration profile at speed **0** (KDE: System Settings, Mouse; GNOME: Settings, Mouse, Mouse Acceleration off).
- Not on Linux: the OBS capture plugin (OBS's PipeWire window capture records the game), the DXGI swapchain hook (the Present FPS Counter still works), the NVIDIA driver profile and the graphics backend choice.

</details>

<details>
<summary><b>My FPS is lower than in other clients, but Kute feels smoother.</b></summary>
<br>

Uncapped, other clients count every frame the game computes, including frames that never reach your screen: they pile up behind the GPU and get replaced before they are shown. That makes a big number, but those extra frames are only extra load and extra input lag. Kute's swap chain hook and patched Chromium let the game run just one frame ahead, so it only computes frames that actually get shown, and the **Present FPS Counter** (Interface settings) shows the frames that reach your screen. A lower number that is real, instead of a higher one that is not.

</details>

<hr>

## 🗒️ API Client

Kute has it's own fully documented API Client: 
- https://github.com/NullDev/krapio
- https://nulldev.github.io/krapio/docs/
- https://www.npmjs.com/package/krapio

<hr>

## :wrench: Building

See [BUILDING.md](BUILDING.md) for what is in this repo and how to build the client and the server.

<hr>

## :handshake: Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. In short:

- Issues labeled [`help wanted`](https://github.com/NullDev/Kute/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22help%20wanted%22) are the best place to start.
- Ask in an issue before working on a new feature. There is no guarantee it gets merged.
- All code must be audited and tested by a human. No AI generated or vibe coded PRs.
- Code must never make performance worse. Anything that costs performance goes behind a setting that is off by default, or does not get added.

> [!IMPORTANT]
> Standalone forks may **not** use the [kute.lol](https://kute.lol) website or its API. If you ship your own client based on Kute, point it at your own server.
> The server (`server/`) is **not** open source. Its code is published for reference only, all rights reserved (see [server/LICENSE](server/LICENSE)), so you may not run, host, copy or reuse it. Write your own. The GPL-3.0 license of this repository covers the client only.

**Contributors <3**

<a href="https://github.com/NullDev/Kute/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=NullDev/Kute&v=1" />
</a>

<sub>Made with [contrib.rocks](https://contrib.rocks).</sub>

<hr>

## :octocat: Credits

- [slavcp/glorp](https://github.com/slavcp/glorp) - base
- [6ct/client-pp](https://github.com/6ct/clientpp) - flags
- [KraXen72/crankshaft](https://github.com/KraXen72/crankshaft) - menu timer css
- [idkr-client/idkr](https://github.com/idkr-client/idkr) - tweaks
- [bigjakk/Electron-Websocket-Fix](https://github.com/bigjakk/Electron-Websocket-Fix) - aim-freeze fix
- [bigjakk/Krunker-Civilian-Client](https://github.com/bigjakk/Krunker-Civilian-Client) - matchmaker, nuke counter, custom sky and keystrokes ideas
- [Alx8g/wok-client](https://github.com/Alx8g/wok-client) - motion blur idea
- [PC7 Client](https://github.com/PC7-Client/PC7-Client) - ideas (badges, QoL, etc.) 
- [Water Client](https://github.com/ghostypostie/Water) - ideas (direct mod downloads)
- [krunkerresourcehub/krh-client](https://github.com/krunkerresourcehub/krh-client) - ideas (Quick Alt-Login, Safe Mode)

<hr>
