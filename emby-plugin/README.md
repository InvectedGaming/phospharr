# Emby.Phospharr

Emby server plugin that lets phospharr push XMLTV guide data directly into
Emby's live-TV database via `ILibraryManager`, instead of relying solely on
Emby's own nightly XMLTV refresh.

## Build

```
chmod +x emby-plugin/*.sh
emby-plugin/fetch-sdk.sh   # copies the MediaBrowser SDK DLLs out of the running Emby container
emby-plugin/build.sh       # emby-plugin/build.sh test  to run the xunit suite first
```

## Deploy

```
EMBY_API_KEY=<key> emby-plugin/install.sh
```

`install.sh` copies `out/Emby.Phospharr.dll` into Emby's plugins directory and
restarts the container. **Every deploy restarts Emby and interrupts live TV**;
the script counts active playback sessions first and refuses unless `--force`
is passed. Run `emby-plugin/install.sh --help` for full usage.

### Environment variables

Both `fetch-sdk.sh` and `install.sh` read their Emby connection details from
the environment — nothing is hard-coded, so the scripts work against any
Emby host/container name.

| Variable            | Used by                | Default                                             | Notes |
|---------------------|-------------------------|------------------------------------------------------|-------|
| `EMBY_URL`           | `install.sh`, `fetch-sdk.sh` | `http://localhost:8096`                          | Emby base URL. `fetch-sdk.sh` only falls back to it if the version can't be read from inside the container. |
| `EMBY_CONTAINER`     | `install.sh`, `fetch-sdk.sh` | `embyserver`                                     | Docker container name for the Emby server. |
| `EMBY_PLUGINS_DIR`   | `install.sh`            | derived via `docker inspect` of `EMBY_CONTAINER`'s `/config` mount (`<mount-source>/plugins`) | Set explicitly if the container isn't running locally or the derivation fails; `install.sh` errors out with the exact variable to set rather than guessing. |
| `EMBY_API_KEY`       | `install.sh`            | *(required, no default)*                             | Sent as an `X-Emby-Token` header, written to a private 0600 temp file and passed to curl as `-H @file`. Never appears in a URL, in `curl`'s argv (so it never shows up in `ps`), or in shell history. |

`fetch-sdk.sh` does not need `EMBY_API_KEY`; `/System/Info/Public` (its only
HTTP fallback call) is unauthenticated.

### Runtime dependencies

Both scripts shell out to `python3` to parse JSON (`install.sh` counts active
playback sessions and reads the `Ping` response; `fetch-sdk.sh` parses the
`/System/Info/Public` fallback to read the Emby version). `docker` and `curl`
are also required.
