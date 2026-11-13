# host-core dependency reviews

## `portable-pty = 0.9.0` (terminal, LOT-010) — reviewed 2026-11-13

Pinned exactly. Part of the WezTerm project (maintainer: Wez Furlong). Reviewed from the
published crate in the local cargo registry:

- `src/unix.rs` (SHA-256 `14c85213b32074d71c8af334531fd027d6a0558dee830282620c88bab056c4b3`):
  `openpty`, then `std::process::Command` with a `pre_exec` that resets signal dispositions
  and the signal mask, calls `setsid()` (the shell leads its own session and process group,
  which is what our orphan watchdog targets), sets the controlling tty and closes inherited
  descriptors. Its `unsafe` is libc FFI for these calls, `ttyname_r`, `ioctl(TIOCSWINSZ)` and
  `fcntl`. No network, no file writes, no build script.
- `src/cmdbuilder.rs` (SHA-256 `db95387276f7f5a2e6bfd27a0c21ad99090f5d29e3663ad0446becec86748283`):
  builds the command; with `new_default_prog` it runs the user's login shell (`getpwuid`
  `pw_shell`, or `$SHELL`) as `-<shell>`. The environment is cleared, then the base
  environment captured at construction is set again, plus `SHELL` and what we add (`TERM`,
  `COLORTERM`, `TERM_PROGRAM`). The working directory falls back to `$HOME` when the requested
  one is not a directory.
- Published package checksum in `Cargo.lock`:
  `b4a596a2b3d2752d94f51fac2d4a96737b8705dddd311a32b9af47211f08671e`.
- New crates in the lockfile: `nix 0.28`, `filedescriptor`, `serial2`, `shell-words`,
  `downcast-rs`, `anyhow` (plus Windows-only `winapi`, `winreg`, `shared_library`, `lazy_static`,
  `bitflags 1`). Not reviewed line by line; `nix` and `anyhow` are widely used.

How we use it: only from `terminal.rs`, after `WorkspaceTrustGate::authorize(Terminal)`; the
shell's group is killed when the session is dropped and by an `OrphanWatchdog` if the Host
dies abruptly. Not behind a cargo feature: the terminal is part of the core editor (LOT-010).
Any version change needs another review.

## `rustix = 1.1.6` (`process` feature, Unix only)

Already in the dependency tree (via `tempfile`). Used for one call: `kill_process_group`
(safe API), so `host-core` keeps `unsafe_code = "forbid"`.

## `@vtsls/language-server = 0.3.0`, `@xterm/xterm = 6.0.0`, `@xterm/addon-fit = 0.11.0` (npm)

Pinned exactly. `vtsls` is a dev dependency so tests run the real server (it bundles the
TypeScript language service; it is not shipped with the app by this LOT). xterm.js 6.0.0 and
its fit addon are the upstream terminal emulator used by VS Code; published 2025-12-22.
