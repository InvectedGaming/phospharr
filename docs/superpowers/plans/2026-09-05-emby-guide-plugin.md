# Emby Guide Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Program data phospharr writes becomes visible in Emby within seconds, with no *Refresh Guide* run — phospharr owns the live-TV guide.

**Architecture:** A C# plugin (`Emby.Phospharr`) exposes `POST /Phospharr/Guide` and upserts `LiveTvProgram` items through `ILibraryManager` — the same call path Emby's own refresh uses — keyed on the exact `ExternalId` Emby would generate, so the nightly refresh becomes a no-op reconciliation. A phospharr push client sends per-channel deltas after each EPG sync and on Twitch liveness changes, and falls back to today's `RefreshGuide` if the plugin is absent. Channels stay on the existing lineup-refresh path.

**Tech Stack:** C# / `netstandard2.0` built in `mcr.microsoft.com/dotnet/sdk:8.0` against Emby 4.9.5's own `MediaBrowser.{Controller,Model,Common}.dll` (copied from the running container, never committed); xunit. phospharr side: Bun + TypeScript, drizzle-orm/SQLite, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-05-emby-guide-plugin-design.md`

## Global Constraints

- Emby is **4.9.5.0**. Compile against the DLLs copied from `embyserver:/system/`; they are proprietary and live in `emby-plugin/lib/` which is **git-ignored**.
- Plugin targets `netstandard2.0`. No NuGet dependency on an Emby SDK package — local `HintPath` references only.
- These names were verified by reflection over the 4.9.5 assemblies and must be used exactly: `MediaBrowser.Common.Plugins.BasePlugin` (non-generic, protected parameterless ctor; abstract `Name`, `Id`); `MediaBrowser.Model.Services.IService`, `RouteAttribute(path, verbs)`, `IReturn<T>`; `MediaBrowser.Controller.Net.AuthenticatedAttribute { Roles }`; `MediaBrowser.Controller.LiveTv.LiveTvProgram` / `LiveTvChannel` (public ctor; `ExternalId`, `ParentId:long`, `InternalId:long`, `StartDate:DateTimeOffset`, `EndDate:DateTimeOffset?`, `Name`, `SortName`, `Overview`, `RunTimeTicks:long?`, `Genres:string[]`, `IsLive/IsNews/IsSports/IsMovie/IsSeries/IsRepeat`, `DateCreated/DateModified`; **there is no `ChannelId` on 4.9.5** — the link is `ParentId`); `MediaBrowser.Controller.Entities.InternalItemsQuery { IncludeItemTypes:string[], ParentIds:long[], MinEndDate, MaxStartDate }`; `ILibraryManager.GetItemList(InternalItemsQuery)`, `CreateItems(List<BaseItem>, BaseItem, MetadataRefreshOptions, BaseItem[], bool, CancellationToken)`, `UpdateItems(List<BaseItem>, BaseItem, ItemUpdateType, MetadataRefreshOptions, CancellationToken)`, `DeleteItem(BaseItem, DeleteOptions, bool)`; `ItemUpdateType.MetadataImport`; `DeleteOptions { DeleteFileLocation, DeleteFromExternalProvider }`; `MediaBrowser.Model.Logging.ILogManager.GetLogger(string)` / `ILogger.Info/Error/ErrorException`; `MediaBrowser.Common.IApplicationHost.ApplicationVersion`. `MediaBrowser.Controller.Net.BaseApiService` does **not** exist in 4.9.5 — services implement `IService` directly.
- Program identity: `ExternalId = "<tvgId>_<startUtc formatted yyyy-MM-dd'T'HH:mm:ss.fffffff'+00:00'>_<channelExternalId>"`, e.g. `starzencorewesterns.us_2026-09-07T23:22:00.0000000+00:00_m3u_d791…_starzencorewesterns.us`. `channelExternalId` is **looked up**, never computed: it is `m3u_<64 hex>_<tvgId>` and the hash is not reproducible from the tuner URL.
- The plugin **never throws out of a handler**; per-channel failures become `{ skipped, reason }`.
- Prune only within the pushed `[windowStart, windowEnd]` and only for channels in the batch.
- Emby's nightly *Refresh Guide* stays **on**. Anything pushed is also emitted in phospharr's XMLTV (`src/epg/export.ts`) — the push client and the export must draw from the same rows.
- `DownstreamServer.guidePush` defaults to `false`. With the plugin absent, behaviour is unchanged (`refreshDownstreamGuides()`).
- Every plugin deploy restarts Emby. `install.sh` refuses when a session is playing unless `--force`.
- phospharr tests run in a container: `docker run --rm -v "$PWD":/w -v /mnt/networked/docker/arrg/phospharr/node_modules:/w/node_modules:ro -w /w -e DATABASE_URL=/tmp/t.db oven/bun:1 bun test <file>`. Two pre-existing `composeReel` tests fail there for lack of ffmpeg; ignore them.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

```
emby-plugin/
  fetch-sdk.sh                       copy MediaBrowser DLLs out of embyserver → lib/emby-<ver>/
  build.sh                           dotnet publish in the sdk container → out/Emby.Phospharr.dll
  install.sh                         session check → docker cp → docker restart embyserver → Ping
  .gitignore                         lib/ out/ bin/ obj/
  Emby.Phospharr/
    Emby.Phospharr.csproj
    Plugin.cs                        BasePlugin: Name / Id / Description
    Api/Contracts.cs                 request/response DTOs (pure)
    Api/GuideApi.cs                  IService: GET /Phospharr/Ping, POST /Phospharr/Guide
    Guide/ProgramIdentity.cs         ExternalId + ISO formatting (pure)
    Guide/GuideDiff.cs               existing × incoming → create/update/delete (pure)
    Guide/GuideWriter.cs             ILibraryManager upsert/prune per channel
  Emby.Phospharr.Tests/
    Emby.Phospharr.Tests.csproj
    ProgramIdentityTests.cs
    GuideDiffTests.cs

src/epg/guide.ts                     guideRows(): the ONE source of programme rows (real + filler)
src/epg/export.ts                    exportXmltv renders guideRows() — no more inline row logic
src/sync/embyguide.ts                push client: ping, delta, chunked POST, fallback
src/db/schema.ts + drizzle/0024_*    guide_push_state
src/settings.ts                      DownstreamServer.guidePush
src/epg/scheduler.ts                 after sync: pushOrRefreshDownstream()
src/api/server.ts                    /api/epg/sync: same
src/health/liveness.ts               Twitch title → channels.customNow; push on change
tests/guiderows.test.ts  tests/embyguide.test.ts  tests/liveness.test.ts (extended)
```

---

### Task 1: Plugin skeleton — builds, loads, answers Ping (Milestone 1 gate)

**Files:**
- Create: `emby-plugin/.gitignore`, `emby-plugin/fetch-sdk.sh`, `emby-plugin/build.sh`, `emby-plugin/install.sh`
- Create: `emby-plugin/Emby.Phospharr/Emby.Phospharr.csproj`, `emby-plugin/Emby.Phospharr/Plugin.cs`, `emby-plugin/Emby.Phospharr/Api/Contracts.cs`, `emby-plugin/Emby.Phospharr/Api/GuideApi.cs`

**Interfaces:**
- Produces: `GET /Phospharr/Ping` → `{ "Version": "<plugin>", "EmbyVersion": "<server>" }`. The `GuideApi` class Task 4 extends with `Post(PushGuideRequest)`.

- [ ] **Step 1: git-ignore the SDK and build output**

`emby-plugin/.gitignore`:
```
lib/
out/
**/bin/
**/obj/
```

- [ ] **Step 2: SDK fetch script**

`emby-plugin/fetch-sdk.sh`:
```bash
#!/bin/bash
# Copy Emby's own plugin-SDK assemblies out of the RUNNING server so the plugin
# compiles against the exact version it will load into. Proprietary — never
# committed (see .gitignore). Re-run after any Emby upgrade.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CONTAINER="${EMBY_CONTAINER:-embyserver}"
VER=$(docker exec "$CONTAINER" sh -c 'cat /system/version.txt 2>/dev/null' || true)
if [[ -z "$VER" ]]; then
  VER=$(curl -s -m 10 "${EMBY_URL:-http://10.125.52.230:8096}/System/Info/Public" | python3 -c 'import sys,json;print(json.load(sys.stdin)["Version"])')
fi
DEST="$HERE/lib/emby-$VER"
mkdir -p "$DEST"
for a in MediaBrowser.Common MediaBrowser.Controller MediaBrowser.Model; do
  docker cp "$CONTAINER:/system/$a.dll" "$DEST/$a.dll"
done
echo "$VER" > "$HERE/lib/VERSION"
echo "SDK $VER → $DEST"
```

- [ ] **Step 3: csproj**

`emby-plugin/Emby.Phospharr/Emby.Phospharr.csproj`:
```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
    <LangVersion>9.0</LangVersion>
    <Nullable>disable</Nullable>
    <AssemblyName>Emby.Phospharr</AssemblyName>
    <RootNamespace>Emby.Phospharr</RootNamespace>
    <Version>0.1.0</Version>
    <!-- Set by build.sh from lib/VERSION; default matches the server this was written against. -->
    <EmbySdkDir Condition="'$(EmbySdkDir)' == ''">$(MSBuildThisFileDirectory)../lib/emby-4.9.5</EmbySdkDir>
  </PropertyGroup>
  <ItemGroup>
    <Reference Include="MediaBrowser.Common"><HintPath>$(EmbySdkDir)/MediaBrowser.Common.dll</HintPath><Private>false</Private></Reference>
    <Reference Include="MediaBrowser.Controller"><HintPath>$(EmbySdkDir)/MediaBrowser.Controller.dll</HintPath><Private>false</Private></Reference>
    <Reference Include="MediaBrowser.Model"><HintPath>$(EmbySdkDir)/MediaBrowser.Model.dll</HintPath><Private>false</Private></Reference>
  </ItemGroup>
</Project>
```

`<Private>false</Private>` so Emby's own DLLs are not copied into `out/` and shipped back into the server.

- [ ] **Step 4: Plugin class**

`emby-plugin/Emby.Phospharr/Plugin.cs`:
```csharp
using System;
using MediaBrowser.Common.Plugins;

namespace Emby.Phospharr
{
    /// <summary>
    /// Registers the plugin with Emby. Everything real lives in Api/GuideApi.cs;
    /// this class exists so Emby lists us and loads the assembly's IService types.
    /// </summary>
    public class Plugin : BasePlugin
    {
        public static readonly Guid PluginId = new Guid("7e1b7c3a-5f7e-4b1e-9c2a-2f0f4b9d1a01");
        public override string Name => "Phospharr Guide";
        public override Guid Id => PluginId;
        public override string Description => "Lets Phospharr write live-TV guide data directly, without a guide refresh.";
    }
}
```

- [ ] **Step 5: Contracts (Ping only for now)**

`emby-plugin/Emby.Phospharr/Api/Contracts.cs`:
```csharp
using System.Collections.Generic;
using MediaBrowser.Model.Services;

namespace Emby.Phospharr.Api
{
    [Route("/Phospharr/Ping", "GET", Summary = "Plugin liveness + version")]
    public class PingRequest : IReturn<PingResult> { }

    public class PingResult
    {
        public string Version { get; set; }
        public string EmbyVersion { get; set; }
    }
}
```

- [ ] **Step 6: Service with Ping**

`emby-plugin/Emby.Phospharr/Api/GuideApi.cs`:
```csharp
using System.Reflection;
using MediaBrowser.Common;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Logging;
using MediaBrowser.Model.Services;

namespace Emby.Phospharr.Api
{
    /// <summary>
    /// HTTP surface. Emby discovers IService implementations in plugin assemblies
    /// automatically and injects constructor dependencies.
    /// </summary>
    public class GuideApi : IService
    {
        private readonly ILibraryManager _library;
        private readonly ILogger _log;
        private readonly IApplicationHost _host;

        public GuideApi(ILibraryManager library, ILogManager logManager, IApplicationHost host)
        {
            _library = library;
            _log = logManager.GetLogger("Phospharr");
            _host = host;
        }

        public object Get(PingRequest request)
        {
            return new PingResult
            {
                Version = typeof(Plugin).Assembly.GetName().Version.ToString(),
                EmbyVersion = _host.ApplicationVersion.ToString(),
            };
        }
    }
}
```

- [ ] **Step 7: build script**

`emby-plugin/build.sh`:
```bash
#!/bin/bash
# Build in the .NET 8 SDK container (there is no dotnet on this host).
# NOTE: never mount anything at /lib inside the container — it shadows the
# system libraries and dotnet fails with "no such file or directory".
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[[ -f "$HERE/lib/VERSION" ]] || { echo "run fetch-sdk.sh first" >&2; exit 1; }
VER=$(cat "$HERE/lib/VERSION")
docker run --rm -v "$HERE":/src -w /src/Emby.Phospharr mcr.microsoft.com/dotnet/sdk:8.0 \
  dotnet publish -c Release -o /src/out --no-self-contained -p:EmbySdkDir=/src/lib/emby-$VER -v q
ls -la "$HERE/out/Emby.Phospharr.dll"
```

- [ ] **Step 8: build**

Run: `chmod +x emby-plugin/*.sh && emby-plugin/fetch-sdk.sh && emby-plugin/build.sh`
Expected: `SDK 4.9.5.0 → …/lib/emby-4.9.5.0` then `out/Emby.Phospharr.dll` listed. If `fetch-sdk.sh` wrote `emby-4.9.5.0` rather than `emby-4.9.5`, that is fine — `build.sh` passes the real directory.

- [ ] **Step 9: install script**

`emby-plugin/install.sh`:
```bash
#!/bin/bash
# Deploy the built DLL and restart Emby. A restart drops every live-TV viewer,
# so refuse while anyone is watching unless --force.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
EMBY="${EMBY_URL:-http://10.125.52.230:8096}"
KEY="${EMBY_API_KEY:?set EMBY_API_KEY}"
PLUGINS="${EMBY_PLUGINS_DIR:-/mnt/networked/docker/arrg/emby-config/plugins}"
CONTAINER="${EMBY_CONTAINER:-embyserver}"
[[ -f "$HERE/out/Emby.Phospharr.dll" ]] || { echo "build first" >&2; exit 1; }

playing=$(curl -s -m 10 "$EMBY/Sessions?api_key=$KEY" | python3 -c 'import sys,json;print(sum(1 for s in json.load(sys.stdin) if s.get("NowPlayingItem")))')
if [[ "$playing" -gt 0 && "${1:-}" != "--force" ]]; then
  echo "refusing: $playing session(s) playing. Re-run with --force to interrupt them." >&2; exit 2
fi
cp "$HERE/out/Emby.Phospharr.dll" "$PLUGINS/Emby.Phospharr.dll"
docker restart "$CONTAINER" >/dev/null
for i in $(seq 1 60); do
  curl -s -m 3 -o /dev/null "$EMBY/System/Info/Public" && break; sleep 2
done
sleep 5
echo "Ping: $(curl -s -m 10 "$EMBY/Phospharr/Ping?api_key=$KEY")"
```

- [ ] **Step 10: install and verify Milestone 1**

Run: `EMBY_API_KEY=<key> emby-plugin/install.sh` (only when nobody is watching, or `--force` with the operator's say-so)
Expected: last line `Ping: {"Version":"0.1.0.0","EmbyVersion":"4.9.5.0"}`.
Also: `docker exec embyserver sh -c 'grep -i phospharr /config/logs/embyserver.txt | tail -3'` shows the plugin loading with no exception. **If Ping does not answer or Emby logs a load error, stop the plan here and report — this is the go/no-go gate.**

- [ ] **Step 11: commit**

```bash
git add emby-plugin
git commit -m "feat(emby-plugin): skeleton that loads into Emby 4.9.5 and answers /Phospharr/Ping

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: ProgramIdentity — Emby-identical ExternalIds (pure, tested)

**Files:**
- Create: `emby-plugin/Emby.Phospharr/Guide/ProgramIdentity.cs`
- Create: `emby-plugin/Emby.Phospharr.Tests/Emby.Phospharr.Tests.csproj`, `emby-plugin/Emby.Phospharr.Tests/ProgramIdentityTests.cs`
- Modify: `emby-plugin/build.sh` (add a `test` mode)

**Interfaces:**
- Produces: `static string ProgramIdentity.FormatStart(DateTimeOffset)`, `static string ProgramIdentity.ExternalId(string tvgId, DateTimeOffset start, string channelExternalId)`, `static bool ProgramIdentity.TryTvgIdFromChannel(string channelExternalId, out string tvgId)`.

- [ ] **Step 1: test project**

`emby-plugin/Emby.Phospharr.Tests/Emby.Phospharr.Tests.csproj`:
```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>disable</Nullable>
    <IsPackable>false</IsPackable>
    <EmbySdkDir Condition="'$(EmbySdkDir)' == ''">$(MSBuildThisFileDirectory)../lib/emby-4.9.5</EmbySdkDir>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.2" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="../Emby.Phospharr/Emby.Phospharr.csproj" />
  </ItemGroup>
</Project>
```

The pure classes under test must not touch Emby types, so the tests never need the Emby DLLs at runtime.

- [ ] **Step 2: failing tests**

`emby-plugin/Emby.Phospharr.Tests/ProgramIdentityTests.cs`:
```csharp
using System;
using Emby.Phospharr.Guide;
using Xunit;

public class ProgramIdentityTests
{
    // Captured from a live Emby 4.9.5 row (USA Starz Encore Westerns, 2026-09-07 23:22 UTC).
    const string Channel = "m3u_d79194b32edab6c51a496f4131d9cdb645785c2ca85e51db130487c22664c178_starzencorewesterns.us";

    [Fact]
    public void FormatStart_matches_embys_seven_digit_utc_form()
    {
        var start = new DateTimeOffset(2026, 9, 7, 23, 22, 0, TimeSpan.Zero);
        Assert.Equal("2026-09-07T23:22:00.0000000+00:00", ProgramIdentity.FormatStart(start));
    }

    [Fact]
    public void FormatStart_normalises_a_non_utc_offset_to_utc()
    {
        var start = new DateTimeOffset(2026, 9, 7, 19, 22, 0, TimeSpan.FromHours(-4)); // same instant, EDT
        Assert.Equal("2026-09-07T23:22:00.0000000+00:00", ProgramIdentity.FormatStart(start));
    }

    [Fact]
    public void ExternalId_reproduces_the_live_row_exactly()
    {
        var start = new DateTimeOffset(2026, 9, 7, 23, 22, 0, TimeSpan.Zero);
        Assert.Equal(
            "starzencorewesterns.us_2026-09-07T23:22:00.0000000+00:00_" + Channel,
            ProgramIdentity.ExternalId("starzencorewesterns.us", start, Channel));
    }

    [Fact]
    public void TryTvgIdFromChannel_extracts_the_suffix_after_the_hash()
    {
        Assert.True(ProgramIdentity.TryTvgIdFromChannel(Channel, out var tvg));
        Assert.Equal("starzencorewesterns.us", tvg);
    }

    [Fact]
    public void TryTvgIdFromChannel_keeps_underscores_inside_the_tvgId()
    {
        Assert.True(ProgramIdentity.TryTvgIdFromChannel("m3u_" + new string('a', 64) + "_live.lofi_girl.x", out var tvg));
        Assert.Equal("live.lofi_girl.x", tvg);
    }

    [Fact]
    public void TryTvgIdFromChannel_rejects_non_m3u_ids()
    {
        Assert.False(ProgramIdentity.TryTvgIdFromChannel("hdhr_1234_5", out _));
        Assert.False(ProgramIdentity.TryTvgIdFromChannel(null, out _));
    }
}
```

- [ ] **Step 3: add test mode to build.sh**

Append to `emby-plugin/build.sh` before the `docker run … publish` line:
```bash
if [[ "${1:-}" == "test" ]]; then
  exec docker run --rm -v "$HERE":/src -w /src/Emby.Phospharr.Tests mcr.microsoft.com/dotnet/sdk:8.0 \
    dotnet test -p:EmbySdkDir=/src/lib/emby-$VER -v q
fi
```

- [ ] **Step 4: run — expect compile failure (ProgramIdentity missing)**

Run: `emby-plugin/build.sh test`
Expected: build error `The type or namespace name 'ProgramIdentity' could not be found`.

- [ ] **Step 5: implement**

`emby-plugin/Emby.Phospharr/Guide/ProgramIdentity.cs`:
```csharp
using System;
using System.Globalization;

namespace Emby.Phospharr.Guide
{
    /// <summary>
    /// Reproduces the identity Emby's own guide refresh assigns to a program, so
    /// rows we write are the rows the nightly refresh expects to find — it then
    /// updates in place instead of duplicating or pruning them.
    ///
    ///   program ExternalId = {tvgId}_{start}_{channelExternalId}
    ///   channel ExternalId = m3u_{64 hex}_{tvgId}   (the hash is NOT reproducible
    ///                                               from the tuner URL — always look it up)
    ///
    /// Pure: no Emby types, so it is unit-testable without the SDK at runtime.
    /// </summary>
    public static class ProgramIdentity
    {
        // Emby writes DateTimeOffset with 7 fractional digits and an explicit +00:00.
        private const string StartFormat = "yyyy-MM-dd'T'HH:mm:ss.fffffff'+00:00'";
        private const string M3uPrefix = "m3u_";
        private const int HashLength = 64;

        public static string FormatStart(DateTimeOffset start)
        {
            return start.ToUniversalTime().ToString(StartFormat, CultureInfo.InvariantCulture);
        }

        public static string ExternalId(string tvgId, DateTimeOffset start, string channelExternalId)
        {
            return tvgId + "_" + FormatStart(start) + "_" + channelExternalId;
        }

        /// <summary>The tvg-id an M3U-tuner channel was created from, or false if this is not one.</summary>
        public static bool TryTvgIdFromChannel(string channelExternalId, out string tvgId)
        {
            tvgId = null;
            if (channelExternalId == null) return false;
            var minLen = M3uPrefix.Length + HashLength + 1;
            if (channelExternalId.Length <= minLen) return false;
            if (!channelExternalId.StartsWith(M3uPrefix, StringComparison.Ordinal)) return false;
            if (channelExternalId[M3uPrefix.Length + HashLength] != '_') return false;
            tvgId = channelExternalId.Substring(minLen);
            return tvgId.Length > 0;
        }
    }
}
```

- [ ] **Step 6: run — expect 6 passing**

Run: `emby-plugin/build.sh test`
Expected: `Passed!  - Failed: 0, Passed: 6`.

- [ ] **Step 7: commit**

```bash
git add emby-plugin
git commit -m "feat(emby-plugin): ProgramIdentity reproduces Emby's program/channel ExternalIds

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: GuideDiff — create/update/delete sets (pure, tested)

**Files:**
- Create: `emby-plugin/Emby.Phospharr/Guide/GuideDiff.cs`
- Create: `emby-plugin/Emby.Phospharr.Tests/GuideDiffTests.cs`
- Modify: `emby-plugin/Emby.Phospharr/Api/Contracts.cs` (add the guide DTOs)

**Interfaces:**
- Consumes: `ProgramIdentity.ExternalId`.
- Produces: DTOs `PushGuideRequest { List<ChannelBatch> Channels }`, `ChannelBatch { string TvgId; DateTimeOffset WindowStart, WindowEnd; List<ProgramDto> Programs }`, `ProgramDto { DateTimeOffset Start, End; string Title, Subtitle, Description, Category; bool IsLive }`, `ChannelResult { string TvgId; int Created, Updated, Deleted; bool Skipped; string Reason }`, `PushGuideResult { List<ChannelResult> Channels; string Error }`.
  And `GuideDiff.Compute(channelExternalId, batch, existing: IReadOnlyList<ExistingProgram>) → DiffResult { List<ProgramDto> Create; List<(ExistingProgram, ProgramDto)> Update; List<ExistingProgram> Delete }` where `ExistingProgram { long InternalId; string ExternalId; DateTimeOffset Start; DateTimeOffset? End; string Name, Overview; bool IsLive }`.

- [ ] **Step 1: DTOs**

Append to `emby-plugin/Emby.Phospharr/Api/Contracts.cs` (inside the namespace):
```csharp
    [Route("/Phospharr/Guide", "POST", Summary = "Upsert guide programs for channels; prunes within each channel's window")]
    [MediaBrowser.Controller.Net.Authenticated(Roles = "Admin")]
    public class PushGuideRequest : IReturn<PushGuideResult>
    {
        public List<ChannelBatch> Channels { get; set; }
    }

    public class ChannelBatch
    {
        public string TvgId { get; set; }
        public System.DateTimeOffset WindowStart { get; set; }
        public System.DateTimeOffset WindowEnd { get; set; }
        public List<ProgramDto> Programs { get; set; }
    }

    public class ProgramDto
    {
        public System.DateTimeOffset Start { get; set; }
        public System.DateTimeOffset End { get; set; }
        public string Title { get; set; }
        public string Subtitle { get; set; }
        public string Description { get; set; }
        /// <summary>Emby colour keyword: Sports / News / Movie / Kids / Series.</summary>
        public string Category { get; set; }
        public bool IsLive { get; set; }
    }

    public class ChannelResult
    {
        public string TvgId { get; set; }
        public int Created { get; set; }
        public int Updated { get; set; }
        public int Deleted { get; set; }
        public bool Skipped { get; set; }
        public string Reason { get; set; }
    }

    public class PushGuideResult
    {
        public List<ChannelResult> Channels { get; set; } = new List<ChannelResult>();
        public string Error { get; set; }
    }
```

- [ ] **Step 2: failing tests**

`emby-plugin/Emby.Phospharr.Tests/GuideDiffTests.cs`:
```csharp
using System;
using System.Collections.Generic;
using System.Linq;
using Emby.Phospharr.Api;
using Emby.Phospharr.Guide;
using Xunit;

public class GuideDiffTests
{
    const string Ch = "m3u_" + "0000000000000000000000000000000000000000000000000000000000000000" + "_foxnews.us";
    static readonly DateTimeOffset T0 = new DateTimeOffset(2026, 9, 6, 0, 0, 0, TimeSpan.Zero);

    static ProgramDto P(int hour, string title, string overview = null, bool live = false) =>
        new ProgramDto { Start = T0.AddHours(hour), End = T0.AddHours(hour + 1), Title = title, Description = overview, Category = "News", IsLive = live };

    static ExistingProgram E(int hour, string title, string overview = null, bool live = false, long id = 1) =>
        new ExistingProgram { InternalId = id, ExternalId = ProgramIdentity.ExternalId("foxnews.us", T0.AddHours(hour), Ch),
                              Start = T0.AddHours(hour), End = T0.AddHours(hour + 1), Name = title, Overview = overview, IsLive = live };

    static ChannelBatch Batch(params ProgramDto[] programs) =>
        new ChannelBatch { TvgId = "foxnews.us", WindowStart = T0, WindowEnd = T0.AddHours(24), Programs = programs.ToList() };

    [Fact]
    public void new_programs_are_created()
    {
        var d = GuideDiff.Compute(Ch, Batch(P(0, "A"), P(1, "B")), new List<ExistingProgram>());
        Assert.Equal(2, d.Create.Count);
        Assert.Empty(d.Update); Assert.Empty(d.Delete);
    }

    [Fact]
    public void identical_program_is_neither_created_nor_updated()
    {
        var d = GuideDiff.Compute(Ch, Batch(P(0, "A", "x")), new List<ExistingProgram> { E(0, "A", "x") });
        Assert.Empty(d.Create); Assert.Empty(d.Update); Assert.Empty(d.Delete);
    }

    [Fact]
    public void changed_title_or_overview_is_an_update_not_a_recreate()
    {
        var d = GuideDiff.Compute(Ch, Batch(P(0, "A2", "x")), new List<ExistingProgram> { E(0, "A", "x") });
        Assert.Single(d.Update); Assert.Empty(d.Create); Assert.Empty(d.Delete);
        Assert.Equal("A2", d.Update[0].Incoming.Title);
    }

    [Fact]
    public void existing_program_absent_from_batch_is_deleted()
    {
        var d = GuideDiff.Compute(Ch, Batch(P(0, "A")), new List<ExistingProgram> { E(0, "A"), E(1, "gone", id: 2) });
        Assert.Single(d.Delete); Assert.Equal(2, d.Delete[0].InternalId);
    }

    [Fact]
    public void programs_outside_the_window_are_never_deleted()
    {
        // existing at hour 30 is beyond WindowEnd (24h) — must be untouched
        var d = GuideDiff.Compute(Ch, Batch(P(0, "A")), new List<ExistingProgram> { E(0, "A"), E(30, "later", id: 3) });
        Assert.Empty(d.Delete);
    }

    [Fact]
    public void a_program_with_a_different_start_is_a_new_identity()
    {
        var d = GuideDiff.Compute(Ch, Batch(P(2, "A")), new List<ExistingProgram> { E(0, "A") });
        Assert.Single(d.Create); Assert.Single(d.Delete);
    }
}
```

- [ ] **Step 3: run — expect compile failure**

Run: `emby-plugin/build.sh test`
Expected: `'GuideDiff' could not be found` / `'ExistingProgram' could not be found`.

- [ ] **Step 4: implement**

`emby-plugin/Emby.Phospharr/Guide/GuideDiff.cs`:
```csharp
using System;
using System.Collections.Generic;
using Emby.Phospharr.Api;

namespace Emby.Phospharr.Guide
{
    /// <summary>A program Emby already holds — the subset of fields the diff compares.</summary>
    public class ExistingProgram
    {
        public long InternalId { get; set; }
        public string ExternalId { get; set; }
        public DateTimeOffset Start { get; set; }
        public DateTimeOffset? End { get; set; }
        public string Name { get; set; }
        public string Overview { get; set; }
        public bool IsLive { get; set; }
    }

    public class ProgramUpdate
    {
        public ExistingProgram Existing;
        public ProgramDto Incoming;
    }

    public class DiffResult
    {
        public List<ProgramDto> Create = new List<ProgramDto>();
        public List<ProgramUpdate> Update = new List<ProgramUpdate>();
        public List<ExistingProgram> Delete = new List<ExistingProgram>();
    }

    /// <summary>
    /// Pure comparison of what Emby has against what phospharr sent. Identity is
    /// the ExternalId (so a moved start time is a new program and an old one),
    /// equality is the displayed fields. Deletion is bounded to the batch window
    /// so a push can never reach outside the range it was told about.
    /// </summary>
    public static class GuideDiff
    {
        public static DiffResult Compute(string channelExternalId, ChannelBatch batch, IReadOnlyList<ExistingProgram> existing)
        {
            var result = new DiffResult();
            var byId = new Dictionary<string, ExistingProgram>(StringComparer.Ordinal);
            foreach (var e in existing) if (e.ExternalId != null) byId[e.ExternalId] = e;

            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var p in batch.Programs ?? new List<ProgramDto>())
            {
                var id = ProgramIdentity.ExternalId(batch.TvgId, p.Start, channelExternalId);
                seen.Add(id);
                if (!byId.TryGetValue(id, out var cur)) { result.Create.Add(p); continue; }
                if (!Same(cur, p)) result.Update.Add(new ProgramUpdate { Existing = cur, Incoming = p });
            }

            foreach (var e in existing)
            {
                if (e.ExternalId == null || seen.Contains(e.ExternalId)) continue;
                // Only prune what lies inside the window this batch claims to describe.
                var end = e.End ?? e.Start;
                if (end <= batch.WindowStart || e.Start >= batch.WindowEnd) continue;
                result.Delete.Add(e);
            }
            return result;
        }

        private static bool Same(ExistingProgram e, ProgramDto p)
        {
            return string.Equals(e.Name, p.Title, StringComparison.Ordinal)
                && string.Equals(e.Overview ?? "", p.Description ?? "", StringComparison.Ordinal)
                && e.End == p.End
                && e.IsLive == p.IsLive;
        }
    }
}
```

- [ ] **Step 5: run — expect 12 passing (6 + 6)**

Run: `emby-plugin/build.sh test`
Expected: `Failed: 0, Passed: 12`.

- [ ] **Step 6: commit**

```bash
git add emby-plugin
git commit -m "feat(emby-plugin): GuideDiff — window-bounded create/update/delete against existing programs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: GuideWriter + POST /Phospharr/Guide — one program visible with no refresh (Milestone 2 gate)

**Files:**
- Create: `emby-plugin/Emby.Phospharr/Guide/GuideWriter.cs`
- Modify: `emby-plugin/Emby.Phospharr/Api/GuideApi.cs` (add `Post`)

**Interfaces:**
- Consumes: `GuideDiff.Compute`, `ProgramIdentity`, DTOs from Task 3.
- Produces: `PushGuideResult GuideWriter.Apply(PushGuideRequest)`; HTTP `POST /Phospharr/Guide` (admin API key) → `PushGuideResult`.

- [ ] **Step 1: the writer**

`emby-plugin/Emby.Phospharr/Guide/GuideWriter.cs`:
```csharp
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Emby.Phospharr.Api;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Logging;

namespace Emby.Phospharr.Guide
{
    /// <summary>
    /// Writes guide programs through ILibraryManager — the same calls Emby's own
    /// Refresh Guide makes (CreateItems / UpdateItems / DeleteItem) — so caches,
    /// ancestor rows and links are Emby's responsibility, not ours.
    ///
    /// One push at a time: Emby's refresh may run concurrently and that is fine
    /// (both go through the library manager), but two of OUR pushes interleaving
    /// on the same channel would diff against stale reads.
    /// </summary>
    public class GuideWriter
    {
        private static readonly object Gate = new object();
        private readonly ILibraryManager _lib;
        private readonly ILogger _log;

        public GuideWriter(ILibraryManager lib, ILogger log) { _lib = lib; _log = log; }

        public PushGuideResult Apply(PushGuideRequest req)
        {
            var result = new PushGuideResult();
            if (req?.Channels == null || req.Channels.Count == 0) return result;
            lock (Gate)
            {
                var channels = IndexChannels();
                foreach (var batch in req.Channels)
                {
                    var r = new ChannelResult { TvgId = batch.TvgId };
                    result.Channels.Add(r);
                    try
                    {
                        if (string.IsNullOrEmpty(batch.TvgId) || !channels.TryGetValue(batch.TvgId, out var targets))
                        {
                            r.Skipped = true; r.Reason = "channel not found"; continue;
                        }
                        // The same tvg-id can exist under more than one tuner (e.g. a channel
                        // moved between phospharr tuner groups before Emby dropped the old
                        // one). Write to every match — they are the same logical channel.
                        foreach (var ch in targets) ApplyToChannel(ch, batch, r);
                    }
                    catch (Exception ex)
                    {
                        r.Skipped = true; r.Reason = ex.GetType().Name + ": " + ex.Message;
                        _log.ErrorException("Phospharr guide push failed for {0}", ex, batch.TvgId);
                    }
                }
            }
            return result;
        }

        /// <summary>tvg-id → every M3U-tuner channel item carrying it.</summary>
        private Dictionary<string, List<LiveTvChannel>> IndexChannels()
        {
            var map = new Dictionary<string, List<LiveTvChannel>>(StringComparer.Ordinal);
            var items = _lib.GetItemList(new InternalItemsQuery { IncludeItemTypes = new[] { typeof(LiveTvChannel).Name } });
            foreach (var item in items)
            {
                var ch = item as LiveTvChannel;
                if (ch == null || !ProgramIdentity.TryTvgIdFromChannel(ch.ExternalId, out var tvg)) continue;
                if (!map.TryGetValue(tvg, out var list)) map[tvg] = list = new List<LiveTvChannel>();
                list.Add(ch);
            }
            return map;
        }

        private void ApplyToChannel(LiveTvChannel ch, ChannelBatch batch, ChannelResult r)
        {
            var existingItems = _lib.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { typeof(LiveTvProgram).Name },
                ParentIds = new[] { ch.InternalId },
                MinEndDate = batch.WindowStart,
                MaxStartDate = batch.WindowEnd,
            }).OfType<LiveTvProgram>().ToList();

            var byId = existingItems.ToDictionary(p => p.InternalId);
            var existing = existingItems.Select(p => new ExistingProgram
            {
                InternalId = p.InternalId, ExternalId = p.ExternalId, Start = p.StartDate, End = p.EndDate,
                Name = p.Name, Overview = p.Overview, IsLive = p.IsLive,
            }).ToList();

            var diff = GuideDiff.Compute(ch.ExternalId, batch, existing);
            var now = DateTimeOffset.UtcNow;

            var creates = diff.Create.Select(p => (BaseItem)Fill(new LiveTvProgram(), p, batch.TvgId, ch, now)).ToList();
            if (creates.Count > 0)
            {
                // Parent null + ParentId set is exactly what LiveTvManager does on refresh.
                _lib.CreateItems(creates, null, null, null, false, CancellationToken.None);
                r.Created += creates.Count;
            }

            var updates = new List<BaseItem>();
            foreach (var u in diff.Update)
            {
                var item = byId[u.Existing.InternalId];
                Fill(item, u.Incoming, batch.TvgId, ch, now);
                updates.Add(item);
            }
            if (updates.Count > 0)
            {
                _lib.UpdateItems(updates, ch, ItemUpdateType.MetadataImport, null, CancellationToken.None);
                r.Updated += updates.Count;
            }

            foreach (var d in diff.Delete)
            {
                _lib.DeleteItem(byId[d.InternalId], new DeleteOptions { DeleteFileLocation = false, DeleteFromExternalProvider = false }, false);
                r.Deleted++;
            }
        }

        private static LiveTvProgram Fill(LiveTvProgram item, ProgramDto p, string tvgId, LiveTvChannel ch, DateTimeOffset now)
        {
            var start = p.Start.ToUniversalTime();
            var end = p.End.ToUniversalTime();
            item.ExternalId = ProgramIdentity.ExternalId(tvgId, start, ch.ExternalId);
            item.ParentId = ch.InternalId;
            item.Name = p.Title ?? "";
            item.SortName = p.Title ?? "";
            item.Overview = p.Description;
            item.StartDate = start;
            item.EndDate = end;
            item.RunTimeTicks = (end - start).Ticks;
            item.IsLive = p.IsLive;
            item.IsNews = string.Equals(p.Category, "News", StringComparison.OrdinalIgnoreCase);
            item.IsSports = string.Equals(p.Category, "Sports", StringComparison.OrdinalIgnoreCase);
            item.IsMovie = string.Equals(p.Category, "Movie", StringComparison.OrdinalIgnoreCase);
            item.IsKids = string.Equals(p.Category, "Kids", StringComparison.OrdinalIgnoreCase);
            item.IsSeries = !(item.IsMovie || item.IsNews || item.IsSports);
            item.Genres = string.IsNullOrEmpty(p.Category) ? Array.Empty<string>() : new[] { p.Category };
            if (item.DateCreated == default) item.DateCreated = now;
            item.DateModified = now;
            return item;
        }
    }
}
```

- [ ] **Step 2: wire the endpoint**

In `emby-plugin/Emby.Phospharr/Api/GuideApi.cs` add a field, construct it, and the handler:
```csharp
        private readonly Emby.Phospharr.Guide.GuideWriter _writer;
        // in the constructor, after _log is set:
        _writer = new Emby.Phospharr.Guide.GuideWriter(library, _log);

        public object Post(PushGuideRequest request)
        {
            // Never let an exception out: Emby's pipeline would answer 500 with no
            // per-channel detail, and phospharr needs to know WHICH channel failed.
            try
            {
                var res = _writer.Apply(request);
                var c = res.Channels;
                _log.Info("Phospharr guide push: {0} channels, +{1} ~{2} -{3}, {4} skipped",
                    c.Count, c.Sum(x => x.Created), c.Sum(x => x.Updated), c.Sum(x => x.Deleted), c.Count(x => x.Skipped));
                return res;
            }
            catch (Exception ex)
            {
                _log.ErrorException("Phospharr guide push failed", ex);
                return new PushGuideResult { Error = ex.GetType().Name + ": " + ex.Message };
            }
        }
```
Add `using System; using System.Linq;` at the top of the file.

- [ ] **Step 3: build + unit tests still green**

Run: `emby-plugin/build.sh test && emby-plugin/build.sh`
Expected: `Passed: 12` and `out/Emby.Phospharr.dll` rebuilt.

- [ ] **Step 4: install (restarts Emby) and run the Milestone 2 gate by hand**

Run: `EMBY_API_KEY=<key> emby-plugin/install.sh`
Then push one program on a low-traffic channel and query it back **without any refresh**:
```bash
K=<key>; E=http://10.125.52.230:8096; U=74a613fc42df42bb8b03993e23e7d61a
NOW=$(date -u +%s)
S=$(date -u -d @$((NOW-300)) +%Y-%m-%dT%H:%M:%SZ); T=$(date -u -d @$((NOW+1800)) +%Y-%m-%dT%H:%M:%SZ)
WS=$(date -u -d @$((NOW-3600)) +%Y-%m-%dT%H:%M:%SZ); WE=$(date -u -d @$((NOW+7200)) +%Y-%m-%dT%H:%M:%SZ)
curl -s -X POST "$E/Phospharr/Guide?api_key=$K" -H 'Content-Type: application/json' -d "{
  \"Channels\":[{\"TvgId\":\"starzencorewesterns.us\",\"WindowStart\":\"$WS\",\"WindowEnd\":\"$WE\",
    \"Programs\":[{\"Start\":\"$S\",\"End\":\"$T\",\"Title\":\"PHOSPHARR PLUGIN TEST\",\"Category\":\"News\",\"IsLive\":true}]}]}"
echo
curl -s "$E/LiveTv/Programs?ChannelIds=19089462&UserId=$U&IsAiring=true&api_key=$K" | python3 -c 'import sys,json;print([p["Name"] for p in json.load(sys.stdin)["Items"]])'
```
Expected: first call `{"Channels":[{"TvgId":"starzencorewesterns.us","Created":1,…}]}`; second call lists `PHOSPHARR PLUGIN TEST`. **Note the prune**: the push window `[WS, WE]` contains that channel's real programs, which were not in the batch — so `Deleted` will be non-zero and those real rows are gone until the nightly refresh restores them. That is the designed behaviour; it is why this is run on a low-traffic channel. **If the program is not visible, stop here and report — this is the go/no-go gate for the whole project.**

- [ ] **Step 5: commit**

```bash
git add emby-plugin
git commit -m "feat(emby-plugin): POST /Phospharr/Guide upserts programs via ILibraryManager — visible with no refresh

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `guideRows()` — one source of programme rows for export and push

**Files:**
- Create: `src/epg/guide.ts`
- Modify: `src/epg/export.ts` (render from `guideRows`; delete the inline row logic)
- Test: `tests/guiderows.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface GuideProgram { start: number; end: number; title: string; subtitle: string | null; description: string | null; category: string; extraCategory: string | null; season: number | null; episode: number | null; iconUrl: string | null }
  export interface GuideChannel { id: number | null; canonicalId: string; name: string; iconUrl: string | null }
  export interface GuideRows { channels: GuideChannel[]; programs: Map<string, GuideProgram[]>; windowStart: number; windowEnd: number }
  export function guideRows(opts?: { catFilter?: { include?: string[]; exclude?: string[] }; logoBase?: string; now?: number }): GuideRows
  export const WINDOW_BEHIND: number; export const WINDOW_AHEAD: number;
  ```
  `exportXmltv(logoBase?, catFilter?)` keeps its signature and output.

- [ ] **Step 1: characterisation fixture — capture today's XML before touching anything**

`tests/guiderows.test.ts` (first half; the second half is added in Step 4):
```ts
import { afterAll, describe, expect, test } from "bun:test";
import { sqlite } from "../src/db/index.ts";
import { exportXmltv } from "../src/epg/export.ts";

// Deterministic fixture: one channel with real programmes, one with none (gets
// synthetic 4h filler), one custom "live" channel whose filler title is customNow.
const NOW = 1_800_000_000; // 2027-01-15T08:00:00Z — hour-aligned so filler blocks are stable
const A = 993001, B = 993002, C = 993003;
sqlite.exec(`INSERT INTO channels (id,name,is_hidden,number,canonical_id,category,genre,kind) VALUES
  (${A},'GR NEWS',0,99301,'gr.news.test','USA News','News','tv'),
  (${B},'GR LOOP',0,99302,'gr.loop.test','24/7 Comedy','Comedy','tv'),
  (${C},'GR TWITCH',0,99303,'gr.twitch.test','Live','Sports','live')`);
sqlite.exec(`UPDATE channels SET custom_now='Live now: chess' WHERE id=${C}`);
sqlite.exec(`INSERT INTO programs (canonical_id,title,subtitle,description,start_time,end_time,category,epg_source) VALUES
  ('gr.news.test','Morning Show','Ep 1','desc',${NOW - 1800},${NOW + 1800},'News','t'),
  ('gr.news.test','Noon Report',NULL,NULL,${NOW + 1800},${NOW + 5400},'News','t')`);
afterAll(() => {
  sqlite.exec(`DELETE FROM programs WHERE canonical_id IN ('gr.news.test')`);
  sqlite.exec(`DELETE FROM channels WHERE id IN (${A},${B},${C})`);
});

const only = (xml: string) => xml.split("\n").filter((l) => /gr\.(news|loop|twitch)\.test/.test(l)).join("\n");

describe("exportXmltv characterisation", () => {
  test("golden: the fixture renders exactly as before the guideRows refactor", async () => {
    const xml = only(await exportXmltv(undefined, undefined));
    await Bun.write("/tmp/guiderows.golden.xml", xml); // written on the FIRST run, pre-refactor
    const golden = await Bun.file("tests/fixtures/guiderows.golden.xml").text().catch(() => xml);
    expect(xml).toBe(golden);
  });
});
```
Note the export uses `Date.now()`; the fixture's absolute times must fall inside its window when the test runs. To make the golden stable, this test mocks time: add at the top `const realNow = Date.now; Date.now = () => NOW * 1000; afterAll(() => { Date.now = realNow; });`.

- [ ] **Step 2: run once, copy the golden into the repo**

Run: `docker run … bun test tests/guiderows.test.ts` (it passes trivially the first time), then
`mkdir -p tests/fixtures && cp /tmp/guiderows.golden.xml tests/fixtures/guiderows.golden.xml`
Open the golden and eyeball it: two `gr.news.test` programmes, a run of `gr.loop.test` 4-hour filler blocks titled `GR LOOP`, and `gr.twitch.test` filler titled `Live now: chess`. Re-run the test: still passes, now against the committed golden.

- [ ] **Step 3: write `guide.ts` by moving the row logic out of `export.ts`**

`src/epg/guide.ts`:
```ts
import { and, eq, isNotNull } from "drizzle-orm";
import { db, sqlite } from "../db/index.ts";
import { channels } from "../db/schema.ts";
import { makeCategoryFilter } from "../content/filter.ts";

/**
 * The guide as phospharr believes it to be: every channel a tuner consumer can
 * see, and for each, the programmes in a rolling window — real EPG rows where
 * we have them, hour-aligned synthetic filler where we don't.
 *
 * This is the ONE place those rows are assembled. The XMLTV export renders
 * them; the Emby guide push sends them. That is what guarantees the invariant
 * the push relies on — anything pushed is also exported — so Emby's nightly
 * refresh finds exactly what the push wrote and reconciles instead of pruning.
 */
export const WINDOW_BEHIND = 2 * 3600;
export const WINDOW_AHEAD = 48 * 3600;
const FILL_BLOCK = 4 * 3600;

export interface GuideProgram {
  start: number; end: number; title: string; subtitle: string | null; description: string | null;
  /** Emby colour keyword: Sports / News / Movie / Kids / Series. */
  category: string;
  /** The programme's own category when it differs from `category`. */
  extraCategory: string | null;
  season: number | null; episode: number | null; iconUrl: string | null;
}
export interface GuideChannel { id: number | null; canonicalId: string; name: string; iconUrl: string | null }
export interface GuideRows { channels: GuideChannel[]; programs: Map<string, GuideProgram[]>; windowStart: number; windowEnd: number }

/** The category vocabulary Emby (and Jellyfin) recognise for guide cell colours. */
export function embyCategory(programCategory: string | null, channelGenre: string | null): string {
  const t = ((programCategory ?? "") + " " + (channelGenre ?? "")).toLowerCase();
  if (/sport/.test(t)) return "Sports";
  if (/news/.test(t)) return "News";
  if (/kids|child|animation|cartoon/.test(t)) return "Kids";
  if (/movie|film|cinema/.test(t)) return "Movie";
  return "Series";
}

const progStmt = sqlite.prepare(
  "SELECT canonical_id, title, subtitle, description, start_time, end_time, category, season, episode, icon_url FROM programs WHERE end_time > ? AND start_time < ? ORDER BY canonical_id, start_time",
);

export function guideRows(opts: { catFilter?: { include?: string[]; exclude?: string[] }; logoBase?: string; now?: number } = {}): GuideRows {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const windowStart = now - WINDOW_BEHIND, windowEnd = now + WINDOW_AHEAD;
  const pass = makeCategoryFilter(opts.catFilter?.include, opts.catFilter?.exclude);
  const rows = db
    .select({ id: channels.id, name: channels.name, canonicalId: channels.canonicalId, logoUrl: channels.logoUrl, genre: channels.genre, kind: channels.kind, customNow: channels.customNow, category: channels.category })
    .from(channels)
    .where(and(eq(channels.isHidden, false), isNotNull(channels.canonicalId)))
    .all()
    .filter((ch) => pass(ch.category));

  const out: GuideChannel[] = [];
  const seen = new Set<string>();
  const genreBy = new Map<string, string | null>();
  const fillTitleBy = new Map<string, string>();
  // Channel 1, the always-listed mosaic — no DB row; main lineup only, mirroring playlistM3U's split.
  if (!opts.catFilter?.include?.length) {
    seen.add("phospharr.mosaic");
    out.push({ id: null, canonicalId: "phospharr.mosaic", name: "Mosaic", iconUrl: null });
    fillTitleBy.set("phospharr.mosaic", "Mosaic — compose in Phospharr");
  }
  for (const ch of rows) {
    if (!ch.canonicalId || seen.has(ch.canonicalId)) continue;
    seen.add(ch.canonicalId);
    genreBy.set(ch.canonicalId, ch.genre);
    // For live/custom channels the filler title is the editable "now" text so
    // Emby shows what's actually on the stream (liveness writes the Twitch title here).
    fillTitleBy.set(ch.canonicalId, ch.kind === "live" && ch.customNow ? ch.customNow : ch.name);
    const iconUrl = ch.logoUrl ? (opts.logoBase ? `${opts.logoBase}/logo/${ch.id}` : ch.logoUrl) : null;
    out.push({ id: ch.id, canonicalId: ch.canonicalId, name: ch.name, iconUrl });
  }

  const programs = new Map<string, GuideProgram[]>();
  const real = progStmt.all(windowStart, windowEnd) as Array<{
    canonical_id: string; title: string; subtitle: string | null; description: string | null;
    start_time: number; end_time: number; category: string | null; season: number | null; episode: number | null; icon_url: string | null;
  }>;
  for (const p of real) {
    if (!seen.has(p.canonical_id)) continue;
    const category = embyCategory(p.category, genreBy.get(p.canonical_id) ?? null);
    const list = programs.get(p.canonical_id) ?? programs.set(p.canonical_id, []).get(p.canonical_id)!;
    list.push({
      start: p.start_time, end: p.end_time, title: p.title, subtitle: p.subtitle, description: p.description,
      category, extraCategory: p.category && p.category !== category ? p.category : null,
      season: p.season, episode: p.episode, iconUrl: p.icon_url,
    });
  }

  // Synthetic filler for channels with no real guide data — overwhelmingly 24/7
  // loops the provider publishes no schedule for. Hour-aligned 4h blocks titled
  // with the channel (or its "now" text) so the guide is never a blank row.
  const fillStart = Math.floor(windowStart / 3600) * 3600;
  for (const cid of seen) {
    if (programs.has(cid)) continue;
    const title = fillTitleBy.get(cid) ?? cid;
    const category = embyCategory(null, genreBy.get(cid) ?? null);
    const list: GuideProgram[] = [];
    for (let t = fillStart; t < windowEnd; t += FILL_BLOCK) {
      list.push({ start: t, end: t + FILL_BLOCK, title, subtitle: null, description: null, category, extraCategory: "24/7", season: null, episode: null, iconUrl: null });
    }
    programs.set(cid, list);
  }
  return { channels: out, programs, windowStart, windowEnd };
}
```

Then rewrite `src/epg/export.ts` to render from it. Keep `esc` and `xmltvTime`; delete `WINDOW_*`, `embyCategory`, `progStmt`, and all row assembly:
```ts
import { guideRows } from "./guide.ts";

function esc(s: string): string { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function xmltvTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
}

/** XMLTV for external consumers (Emby, Jellyfin, TiviMate, …). A pure rendering
 *  of guideRows() — see src/epg/guide.ts for what is exported and why. */
export async function exportXmltv(logoBase?: string, catFilter?: { include?: string[]; exclude?: string[] }): Promise<string> {
  const g = guideRows({ catFilter, logoBase });
  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="Phospharr">'];
  for (const ch of g.channels) {
    parts.push(
      `<channel id="${esc(ch.canonicalId)}"><display-name>${esc(ch.name)}</display-name>` +
        (ch.iconUrl ? `<icon src="${esc(ch.iconUrl)}"/>` : "") + "</channel>",
    );
  }
  for (const ch of g.channels) {
    for (const p of g.programs.get(ch.canonicalId) ?? []) {
      // xmltv_ns is 0-based: "season-1 . episode-1 ."
      const ep = p.season != null && p.episode != null ? `${p.season - 1}.${p.episode - 1}.` : null;
      parts.push(
        `<programme start="${xmltvTime(p.start)}" stop="${xmltvTime(p.end)}" channel="${esc(ch.canonicalId)}">` +
          `<title>${esc(p.title)}</title>` +
          (p.subtitle ? `<sub-title>${esc(p.subtitle)}</sub-title>` : "") +
          (p.description ? `<desc>${esc(p.description)}</desc>` : "") +
          `<category>${p.category}</category>` +
          (p.extraCategory ? `<category>${esc(p.extraCategory)}</category>` : "") +
          (ep ? `<episode-num system="xmltv_ns">${ep}</episode-num>` : "") +
          (p.iconUrl ? `<icon src="${esc(p.iconUrl)}"/>` : "") +
          "</programme>",
      );
    }
  }
  parts.push("</tv>");
  return parts.join("\n");
}
```
**Ordering caveat the golden will catch:** the old code emitted real programmes in `ORDER BY canonical_id, start_time` across all channels, then all filler blocks. The new code emits per channel in channel order. If the golden fails only on line order, sort `g.channels` by `canonicalId` when rendering programmes and emit real-programme channels before filler channels — match the golden, do not regenerate it.

- [ ] **Step 4: behaviour tests for guideRows**

Append to `tests/guiderows.test.ts`:
```ts
import { guideRows, WINDOW_AHEAD, WINDOW_BEHIND } from "../src/epg/guide.ts";

describe("guideRows", () => {
  test("real programmes come through with Emby colour category and window bounds", () => {
    const g = guideRows({ now: NOW });
    expect(g.windowStart).toBe(NOW - WINDOW_BEHIND);
    expect(g.windowEnd).toBe(NOW + WINDOW_AHEAD);
    const news = g.programs.get("gr.news.test")!;
    expect(news.map((p) => p.title)).toEqual(["Morning Show", "Noon Report"]);
    expect(news[0]!.category).toBe("News");
  });

  test("a channel with no rows gets hour-aligned 4h filler across the whole window", () => {
    const g = guideRows({ now: NOW });
    const fill = g.programs.get("gr.loop.test")!;
    expect(fill.length).toBeGreaterThan(10);
    expect(fill[0]!.start % 3600).toBe(0);
    expect(fill.every((p) => p.end - p.start === 4 * 3600 && p.title === "GR LOOP" && p.extraCategory === "24/7")).toBe(true);
    expect(fill[fill.length - 1]!.start).toBeLessThan(g.windowEnd);
  });

  test("a live channel's filler title is its customNow text", () => {
    const g = guideRows({ now: NOW });
    expect(g.programs.get("gr.twitch.test")![0]!.title).toBe("Live now: chess");
  });

  test("the mosaic is present only in the unfiltered (main) lineup", () => {
    expect(guideRows({ now: NOW }).channels.some((c) => c.canonicalId === "phospharr.mosaic")).toBe(true);
    expect(guideRows({ now: NOW, catFilter: { include: ["Live"] } }).channels.some((c) => c.canonicalId === "phospharr.mosaic")).toBe(false);
  });

  test("catFilter include/exclude scopes channels exactly like the export routes", () => {
    const inc = guideRows({ now: NOW, catFilter: { include: ["Live"] } }).channels.map((c) => c.canonicalId);
    expect(inc).toContain("gr.twitch.test");
    expect(inc).not.toContain("gr.news.test");
    const exc = guideRows({ now: NOW, catFilter: { exclude: ["Live"] } }).channels.map((c) => c.canonicalId);
    expect(exc).not.toContain("gr.twitch.test");
    expect(exc).toContain("gr.news.test");
  });
});
```

- [ ] **Step 5: run — golden must still pass, plus 5 new**

Run: `docker run … bun test tests/guiderows.test.ts`
Expected: 6 pass. Then `bun x tsc --noEmit` clean and the full suite unchanged apart from the two ffmpeg tests.

- [ ] **Step 6: commit**

```bash
git add src/epg/guide.ts src/epg/export.ts tests/guiderows.test.ts tests/fixtures/guiderows.golden.xml
git commit -m "refactor(epg): guideRows() is the single source of guide rows; exportXmltv renders it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `guide_push_state` table + `guidePush` setting

**Files:**
- Modify: `src/db/schema.ts` (append table), `src/settings.ts:20-27` (`DownstreamServer`)
- Create: `drizzle/0024_guide_push_state.sql` + journal entry (via `bun run db:generate`)

**Interfaces:**
- Produces: `guidePushState` drizzle table `{ serverId: text, canonicalId: text, fingerprint: text, pushedAt: integer }` PK `(serverId, canonicalId)`; `DownstreamServer.guidePush?: boolean`.

- [ ] **Step 1: schema**

Append to `src/db/schema.ts`:
```ts
// ─── EMBY GUIDE PUSH: per-channel fingerprint of the last programme set we
// pushed to a downstream server's guide plugin, so each push sends only the
// channels that changed. Row absent = never pushed / last push not acknowledged.
export const guidePushState = sqliteTable(
  "guide_push_state",
  {
    serverId: text("server_id").notNull(),
    canonicalId: text("canonical_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    pushedAt: integer("pushed_at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.serverId, t.canonicalId] }) }),
);
```

- [ ] **Step 2: setting**

In `src/settings.ts`, `DownstreamServer`:
```ts
  enabled: boolean;
  /** Push guide programmes straight into this server via the Phospharr plugin
   *  instead of asking it to run a full guide refresh. Off = today's behaviour. */
  guidePush?: boolean;
```

- [ ] **Step 3: generate + apply the migration**

Run (in the bun container, worktree mounted, node_modules mounted): `bun run db:generate` then `bun run db:migrate` with `DATABASE_URL=/tmp/t.db`.
Expected: `drizzle/0024_<name>.sql` containing `CREATE TABLE guide_push_state …` with the composite primary key, `drizzle/meta/0024_snapshot.json`, and a new `_journal.json` entry with `idx: 24`. Migrations apply cleanly.

- [ ] **Step 4: tsc + commit**

Run: `bun x tsc --noEmit` — clean.
```bash
git add src/db/schema.ts src/settings.ts drizzle
git commit -m "feat(epg): guide_push_state table and DownstreamServer.guidePush (default off)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: push client — ping, delta, chunked POST, fallback

**Files:**
- Create: `src/sync/embyguide.ts`
- Test: `tests/embyguide.test.ts`

**Interfaces:**
- Consumes: `guideRows()` (Task 5), `guidePushState` (Task 6), `DownstreamServer`, `refreshDownstreamGuides` from `src/epg/downstream.ts`.
- Produces:
  ```ts
  export interface PushOutcome { serverId: string; mode: "pushed" | "fallback" | "disabled"; channelsSent: number; created: number; updated: number; deleted: number; skipped: number; error?: string }
  export async function pushGuide(server: DownstreamServer, opts?: { now?: number; chunk?: number }): Promise<PushOutcome>
  export async function pushOrRefreshDownstream(): Promise<PushOutcome[]>
  export function fingerprint(programs: GuideProgram[]): string
  export function _resetGuidePushState(serverId: string): void   // test-only
  ```

- [ ] **Step 1: failing tests**

`tests/embyguide.test.ts`:
```ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sqlite } from "../src/db/index.ts";
import type { DownstreamServer } from "../src/settings.ts";
import { pushGuide, fingerprint, _resetGuidePushState } from "../src/sync/embyguide.ts";

const NOW = 1_800_000_000;
const A = 994001, B = 994002;
sqlite.exec(`INSERT INTO channels (id,name,is_hidden,number,canonical_id,category,genre,kind) VALUES
  (${A},'EG NEWS',0,99401,'eg.news.test','USA News','News','tv'),
  (${B},'EG LOOP',0,99402,'eg.loop.test','24/7 Comedy','Comedy','tv')`);
sqlite.exec(`INSERT INTO programs (canonical_id,title,start_time,end_time,category,epg_source) VALUES
  ('eg.news.test','Show',${NOW - 600},${NOW + 3000},'News','t')`);
afterAll(() => {
  sqlite.exec(`DELETE FROM programs WHERE canonical_id='eg.news.test'`);
  sqlite.exec(`DELETE FROM channels WHERE id IN (${A},${B})`);
  sqlite.exec(`DELETE FROM guide_push_state WHERE server_id LIKE 'eg-%'`);
});

type Seen = { method: string; path: string; body?: any };
function fakePlugin(opts: { ping?: boolean; skip?: string[] } = {}) {
  const seen: Seen[] = [];
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const rec: Seen = { method: req.method, path: u.pathname };
      if (req.method === "POST") rec.body = await req.json();
      seen.push(rec);
      if (u.pathname === "/Phospharr/Ping") return opts.ping === false ? new Response("nope", { status: 404 }) : Response.json({ Version: "0.1.0.0", EmbyVersion: "4.9.5.0" });
      if (u.pathname === "/Phospharr/Guide") {
        const chans = (rec.body.Channels as any[]).map((c) =>
          opts.skip?.includes(c.TvgId) ? { TvgId: c.TvgId, Skipped: true, Reason: "channel not found" }
                                        : { TvgId: c.TvgId, Created: c.Programs.length, Updated: 0, Deleted: 0, Skipped: false });
        return Response.json({ Channels: chans });
      }
      if (u.pathname === "/ScheduledTasks") return Response.json([{ Id: "rg", Key: "RefreshGuide", Name: "Refresh Guide" }]);
      if (u.pathname.startsWith("/ScheduledTasks/Running/")) return new Response(null, { status: 204 });
      return new Response("?", { status: 404 });
    },
  });
  const server: DownstreamServer = { id: `eg-${srv.port}`, type: "emby", name: "e", url: `http://127.0.0.1:${srv.port}`, apiKey: "k", enabled: true, guidePush: true };
  return { srv, seen, server, posts: () => seen.filter((s) => s.path === "/Phospharr/Guide") };
}

describe("fingerprint", () => {
  test("is stable for equal programme sets and differs when a title changes", () => {
    const a = [{ start: 1, end: 2, title: "x", subtitle: null, description: null, category: "News", extraCategory: null, season: null, episode: null, iconUrl: null }];
    const b = [{ ...a[0]!, title: "y" }];
    expect(fingerprint(a)).toBe(fingerprint([...a]));
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });
});

describe("pushGuide", () => {
  test("first push sends every channel, records fingerprints, reports counts", async () => {
    const f = fakePlugin(); _resetGuidePushState(f.server.id);
    const out = await pushGuide(f.server, { now: NOW });
    expect(out.mode).toBe("pushed");
    expect(out.channelsSent).toBeGreaterThanOrEqual(2);
    const sent = f.posts().flatMap((p) => p.body.Channels.map((c: any) => c.TvgId));
    expect(sent).toContain("eg.news.test"); expect(sent).toContain("eg.loop.test");
    const news = f.posts().flatMap((p) => p.body.Channels).find((c: any) => c.TvgId === "eg.news.test");
    expect(news.Programs[0].Title).toBe("Show");
    expect(new Date(news.Programs[0].Start).getTime() / 1000).toBe(NOW - 600); // ISO, UTC
    const rows = sqlite.query("SELECT count(*) c FROM guide_push_state WHERE server_id=?").get(f.server.id) as { c: number };
    expect(rows.c).toBeGreaterThanOrEqual(2);
    f.srv.stop(true);
  });

  test("second push with nothing changed sends nothing", async () => {
    const f = fakePlugin(); _resetGuidePushState(f.server.id);
    await pushGuide(f.server, { now: NOW });
    const before = f.posts().length;
    const out = await pushGuide(f.server, { now: NOW });
    expect(out.channelsSent).toBe(0);
    expect(f.posts().length).toBe(before);
    f.srv.stop(true);
  });

  test("a changed programme re-sends only that channel", async () => {
    const f = fakePlugin(); _resetGuidePushState(f.server.id);
    await pushGuide(f.server, { now: NOW });
    sqlite.exec(`UPDATE programs SET title='Show 2' WHERE canonical_id='eg.news.test'`);
    const out = await pushGuide(f.server, { now: NOW });
    expect(out.channelsSent).toBe(1);
    expect(f.posts().at(-1)!.body.Channels[0].TvgId).toBe("eg.news.test");
    sqlite.exec(`UPDATE programs SET title='Show' WHERE canonical_id='eg.news.test'`);
    f.srv.stop(true);
  });

  test("a skipped channel keeps no fingerprint, so it is retried next push", async () => {
    const f = fakePlugin({ skip: ["eg.loop.test"] }); _resetGuidePushState(f.server.id);
    const out = await pushGuide(f.server, { now: NOW });
    expect(out.skipped).toBeGreaterThanOrEqual(1);
    const row = sqlite.query("SELECT 1 FROM guide_push_state WHERE server_id=? AND canonical_id='eg.loop.test'").get(f.server.id);
    expect(row).toBeNull();
    await pushGuide(f.server, { now: NOW });
    expect(f.posts().at(-1)!.body.Channels.map((c: any) => c.TvgId)).toContain("eg.loop.test");
    f.srv.stop(true);
  });

  test("plugin absent → fallback to RefreshGuide, nothing pushed", async () => {
    const f = fakePlugin({ ping: false }); _resetGuidePushState(f.server.id);
    const out = await pushGuide(f.server, { now: NOW });
    expect(out.mode).toBe("fallback");
    expect(f.posts().length).toBe(0);
    expect(f.seen.some((s) => s.path.startsWith("/ScheduledTasks/Running/"))).toBe(true);
    f.srv.stop(true);
  });

  test("guidePush off → disabled, no traffic at all", async () => {
    const f = fakePlugin();
    const out = await pushGuide({ ...f.server, guidePush: false }, { now: NOW });
    expect(out.mode).toBe("disabled");
    expect(f.seen.length).toBe(0);
    f.srv.stop(true);
  });

  test("large lineups are chunked", async () => {
    const f = fakePlugin(); _resetGuidePushState(f.server.id);
    await pushGuide(f.server, { now: NOW, chunk: 1 });
    expect(f.posts().length).toBeGreaterThanOrEqual(2);
    expect(f.posts().every((p) => p.body.Channels.length === 1)).toBe(true);
    f.srv.stop(true);
  });
});
```

- [ ] **Step 2: run — expect module-not-found**

Run: `docker run … bun test tests/embyguide.test.ts`
Expected: `Cannot find module '../src/sync/embyguide.ts'`.

- [ ] **Step 3: implement**

`src/sync/embyguide.ts`:
```ts
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { guidePushState } from "../db/schema.ts";
import { getSetting, type DownstreamServer } from "../settings.ts";
import { guideRows, type GuideProgram } from "../epg/guide.ts";
import { refreshDownstreamGuides } from "../epg/downstream.ts";

/**
 * Push guide programmes into Emby through the Phospharr plugin, so a change is
 * in the guide within seconds instead of after the nightly 15-minute Refresh
 * Guide. See docs/superpowers/specs/2026-09-05-emby-guide-plugin-design.md.
 *
 * Delta only: a per-channel fingerprint of the programme set is kept in
 * guide_push_state; only channels whose set changed are sent. A channel the
 * plugin reports as skipped keeps NO fingerprint, so it is retried next time —
 * "channel not found" is the normal state until Emby's lineup refresh lands it.
 *
 * The plugin being absent must change nothing: a failed Ping falls back to the
 * existing RefreshGuide path. Off by default per server.
 */
export interface PushOutcome {
  serverId: string; mode: "pushed" | "fallback" | "disabled";
  channelsSent: number; created: number; updated: number; deleted: number; skipped: number; error?: string;
}

const DEFAULT_CHUNK = 200; // channels per POST — keeps a request well under a second of plugin work
const PING_TIMEOUT_MS = 8_000;
const PUSH_TIMEOUT_MS = 120_000;

function headers(s: DownstreamServer): Record<string, string> {
  return { "X-Emby-Token": s.apiKey, "X-MediaBrowser-Token": s.apiKey, Authorization: `MediaBrowser Token="${s.apiKey}"`, Accept: "application/json", "Content-Type": "application/json" };
}
const iso = (unixSec: number) => new Date(unixSec * 1000).toISOString();

/** Order-independent over the fields Emby displays; a changed title, time or description changes it. */
export function fingerprint(programs: GuideProgram[]): string {
  const canon = [...programs].sort((a, b) => a.start - b.start)
    .map((p) => [p.start, p.end, p.title, p.description ?? "", p.category]);
  return Bun.hash(JSON.stringify(canon)).toString(16);
}

async function ping(s: DownstreamServer): Promise<boolean> {
  try {
    const r = await fetch(`${s.url.replace(/\/+$/, "")}/Phospharr/Ping`, { headers: headers(s), signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    return r.ok;
  } catch { return false; }
}

export async function pushGuide(s: DownstreamServer, opts: { now?: number; chunk?: number } = {}): Promise<PushOutcome> {
  const out: PushOutcome = { serverId: s.id, mode: "pushed", channelsSent: 0, created: 0, updated: 0, deleted: 0, skipped: 0 };
  if (!s.guidePush || !s.enabled || !s.url || !s.apiKey) return { ...out, mode: "disabled" };
  if (!(await ping(s))) {
    // No plugin → the old path. One line, not one per tick: this is a steady state, not an incident.
    await refreshDownstreamGuides().catch(() => []);
    return { ...out, mode: "fallback", error: "plugin not reachable — fell back to RefreshGuide" };
  }

  const g = guideRows({ now: opts.now });
  const known = new Map(
    db.select({ canonicalId: guidePushState.canonicalId, fingerprint: guidePushState.fingerprint })
      .from(guidePushState).where(eq(guidePushState.serverId, s.id)).all()
      .map((r) => [r.canonicalId, r.fingerprint] as const),
  );
  const pending: { canonicalId: string; fp: string; programs: GuideProgram[] }[] = [];
  for (const ch of g.channels) {
    const programs = g.programs.get(ch.canonicalId) ?? [];
    const fp = fingerprint(programs);
    if (known.get(ch.canonicalId) === fp) continue;
    pending.push({ canonicalId: ch.canonicalId, fp, programs });
  }
  if (!pending.length) return out;

  const chunk = Math.max(1, opts.chunk ?? DEFAULT_CHUNK);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  for (let i = 0; i < pending.length; i += chunk) {
    const slice = pending.slice(i, i + chunk);
    const body = {
      Channels: slice.map((c) => ({
        TvgId: c.canonicalId, WindowStart: iso(g.windowStart), WindowEnd: iso(g.windowEnd),
        Programs: c.programs.map((p) => ({ Start: iso(p.start), End: iso(p.end), Title: p.title, Subtitle: p.subtitle, Description: p.description, Category: p.category, IsLive: p.extraCategory === "24/7" || p.category === "Sports" })),
      })),
    };
    let res: { Channels?: { TvgId: string; Created?: number; Updated?: number; Deleted?: number; Skipped?: boolean; Reason?: string }[]; Error?: string };
    try {
      const r = await fetch(`${s.url.replace(/\/+$/, "")}/Phospharr/Guide`, { method: "POST", headers: headers(s), body: JSON.stringify(body), signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      res = (await r.json()) as typeof res;
      if (res.Error) throw new Error(res.Error);
    } catch (e) {
      // This chunk keeps its old fingerprints and is retried next push; later chunks still go.
      out.error = e instanceof Error ? e.message : String(e);
      console.error(`[guidepush] ${s.name}: chunk ${i / chunk + 1} failed — ${out.error}`);
      continue;
    }
    out.channelsSent += slice.length;
    const ok: { canonicalId: string; fp: string }[] = [];
    for (const c of slice) {
      const r = res.Channels?.find((x) => x.TvgId === c.canonicalId);
      if (!r || r.Skipped) { out.skipped++; continue; }
      out.created += r.Created ?? 0; out.updated += r.Updated ?? 0; out.deleted += r.Deleted ?? 0;
      ok.push({ canonicalId: c.canonicalId, fp: c.fp });
    }
    if (ok.length) {
      for (const o of ok) {
        db.insert(guidePushState).values({ serverId: s.id, canonicalId: o.canonicalId, fingerprint: o.fp, pushedAt: now })
          .onConflictDoUpdate({ target: [guidePushState.serverId, guidePushState.canonicalId], set: { fingerprint: o.fp, pushedAt: now } }).run();
      }
    }
  }
  console.log(`[guidepush] ${s.name}: ${out.channelsSent} channel(s) +${out.created} ~${out.updated} -${out.deleted}, ${out.skipped} skipped`);
  return out;
}

/** Every enabled downstream server: push where guidePush is on, else the old refresh. */
export async function pushOrRefreshDownstream(): Promise<PushOutcome[]> {
  const servers = (await getSetting("epg.downstream")) ?? [];
  const pushing = servers.filter((s) => s.enabled && s.guidePush);
  const results = await Promise.all(pushing.map((s) => pushGuide(s)));
  if (pushing.length < servers.filter((s) => s.enabled).length) await refreshDownstreamGuides().catch(() => []);
  return results;
}

/** Test-only: forget one server's fingerprints. */
export function _resetGuidePushState(serverId: string): void {
  db.delete(guidePushState).where(eq(guidePushState.serverId, serverId)).run();
}
```
`inArray`/`and` are imported for a follow-up prune helper; if `tsc` flags them unused, drop them.

- [ ] **Step 4: run — expect 8 passing**

Run: `docker run … bun test tests/embyguide.test.ts` → `8 pass`. `bun x tsc --noEmit` clean.

- [ ] **Step 5: commit**

```bash
git add src/sync/embyguide.ts tests/embyguide.test.ts
git commit -m "feat(sync): Emby guide push client — per-channel deltas, chunked, falls back to RefreshGuide

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: wire the push into the EPG sync + prove idempotence with the nightly refresh (integration gate)

**Files:**
- Modify: `src/epg/scheduler.ts:30-36`, `src/api/server.ts` (`/api/epg/sync` handler, ~line 1396-1406)

**Interfaces:**
- Consumes: `pushOrRefreshDownstream()`.

- [ ] **Step 1: scheduler**

In `src/epg/scheduler.ts` replace the import of `refreshDownstreamGuides` with `import { pushOrRefreshDownstream } from "../sync/embyguide.ts";` and the line
`await refreshDownstreamGuides().catch(() => { /* best-effort, never blocks */ });`
with
`await pushOrRefreshDownstream().catch(() => { /* best-effort, never blocks */ });`
Update the comment above it: `// Our guide is fresh — push it straight into servers running the Phospharr plugin, nudge the rest to reload theirs…`.

- [ ] **Step 2: manual sync route**

In `src/api/server.ts` `/api/epg/sync`, replace `const downstream = await refreshDownstreamGuides().catch(() => []);` with `const downstream = await pushOrRefreshDownstream().catch(() => []);` and add the import. Keep the `refreshDownstreamGuides` import only if still used elsewhere in the file.

- [ ] **Step 3: tsc + full suite**

Run: `bun x tsc --noEmit`; full `bun test` — pass count up by the new tests, no new failures.

- [ ] **Step 4: enable for Emby and observe a real push**

Set `guidePush: true` on the `emby-main` entry of `epg.downstream` (through the settings UI, or `setSetting("epg.downstream", …)` via `docker exec phospharr bun -e`), restart phospharr, and watch:
`docker logs phospharr -f | grep -E '\[guidepush\]|\[epg\]'`
Expected within a minute of boot: `[epg] auto-refresh: … programmes` followed by `[guidepush] Emby (The Archives): N channel(s) +… ~… -…, S skipped`. Then confirm in Emby, no refresh run:
`curl -s "$E/LiveTv/Programs?ChannelIds=18884809&UserId=$U&IsAiring=true&api_key=$K"` shows the current Fox News programme matching phospharr's guide.

- [ ] **Step 5: integration gate 2 — the nightly refresh is a no-op on pushed channels**

Start Emby's task: `curl -s -X POST "$E/ScheduledTasks/Running/9492d30c70f7f1bec3757c9d0a4feb45?api_key=$K"`, wait for it to finish, then:
`docker exec embyserver sh -c "grep -E 'Saving [0-9]+ programs for channel 18884809|Removing [0-9]+ old programs from channel 18884809' /config/logs/embyserver.txt | tail -2"`
Expected: `Removing 0 old programs` for Fox News (Emby found nothing to prune because every programme it ingested already existed with the same ExternalId). Also record a programme's Emby item `Id` before and after the run — it must be unchanged (updated in place, not recreated). If Emby removes or recreates pushed programmes, the ExternalId derivation has drifted from what this Emby build generates — stop and compare a pushed row against a refresh-created row in `library.db` before going further.

- [ ] **Step 6: commit**

```bash
git add src/epg/scheduler.ts src/api/server.ts
git commit -m "feat(epg): push the guide into Emby after every sync; refresh only servers without the plugin

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Twitch "Live now: <title>" — instant guide text on liveness changes

**Files:**
- Modify: `src/health/liveness.ts` (fetch `title`; write `channels.customNow`; trigger a push)
- Test: `tests/liveness.test.ts` (extend)

**Interfaces:**
- Consumes: `pushOrRefreshDownstream()`; `guideRows()` already uses `customNow` as the filler title for `kind = "live"` channels (Task 5), so the same text reaches both the XMLTV and the push — the "anything pushed is exported" rule holds by construction.
- Produces: `fetchLiveness` returns `Map<string, { live: boolean; title: string | null }>`; `pollOnce` sets `customNow = "Live now: <title>"` while broadcasting and clears it when not.

- [ ] **Step 1: failing tests**

Append to `tests/liveness.test.ts` (reuse its fixtures `ON`, `OFF`, `healthOf`):
```ts
const nowOf = (ch: number): string | null =>
  (sqlite.query(`SELECT custom_now FROM channels WHERE id = ${ch}`).get() as { custom_now: string | null }).custom_now;

describe("live title → guide text", () => {
  test("a broadcasting channel's customNow becomes 'Live now: <title>'", async () => {
    await pollOnce(async () => new Map([["liveone", { live: true, title: "Speedrun marathon" }]]));
    expect(nowOf(ON)).toBe("Live now: Speedrun marathon");
  });

  test("going offline clears customNow so the filler falls back to the channel name", async () => {
    await pollOnce(async () => new Map([["liveone", { live: true, title: "x" }]]));
    await pollOnce(async () => new Map([["liveone", { live: false, title: null }]]));
    expect(nowOf(ON)).toBeNull();
  });

  test("a title change alone counts as a change (so the guide is re-pushed)", async () => {
    await pollOnce(async () => new Map([["liveone", { live: true, title: "a" }]]));
    const r = await pollOnce(async () => new Map([["liveone", { live: true, title: "b" }]]));
    expect(r.changed).toBe(true);
    expect(nowOf(ON)).toBe("Live now: b");
  });

  test("no change → no push trigger", async () => {
    await pollOnce(async () => new Map([["liveone", { live: true, title: "a" }]]));
    const r = await pollOnce(async () => new Map([["liveone", { live: true, title: "a" }]]));
    expect(r.changed).toBe(false);
  });
});
```
Also update the existing liveness tests' fetcher maps from `[login, boolean]` to `[login, { live, title: null }]`.

- [ ] **Step 2: run — expect type/shape failures**

Run: `docker run … bun test tests/liveness.test.ts` → the new tests fail (`changed` undefined, `customNow` untouched).

- [ ] **Step 3: implement**

In `src/health/liveness.ts`:

1. Change the GQL selection to `stream { id title }` and the return type of `fetchLiveness` to `Map<string, { live: boolean; title: string | null }>`; set `out.set(login, { live: u.stream != null, title: u.stream?.title ?? null })`. Define `export type LiveState = { live: boolean; title: string | null }`.
2. In `pollOnce`, select `channelId` alongside `id/url/health` (`streams.channelId`), and read the current `customNow` for those channels via one `db.select({ id: channels.id, customNow: channels.customNow }).from(channels).where(inArray(channels.id, ids)).all()`.
3. After the health writes, compute per channel the desired text: `live ? \`Live now: ${title ?? "streaming"}\` : null`; where it differs from the stored `customNow`, `db.update(channels).set({ customNow }).where(eq(channels.id, channelId)).run()` and set `changed = true`. A health flip (`toLive`/`toDead` non-empty) also sets `changed = true`.
4. Return `{ live, offline, skipped, changed }`.
5. In `tick()`, after `pollOnce()`: `if (r.changed) scheduleGuidePush();` where
```ts
let pushTimer: ReturnType<typeof setTimeout> | null = null;
/** Coalesce a burst of liveness changes into one push, ~10s later. */
function scheduleGuidePush(): void {
  if (pushTimer) return;
  pushTimer = setTimeout(() => { pushTimer = null; void pushOrRefreshDownstream().catch((e) => console.error("[liveness] guide push failed:", e)); }, 10_000);
  if (typeof pushTimer.unref === "function") pushTimer.unref();
}
```
with `import { pushOrRefreshDownstream } from "../sync/embyguide.ts";`. Note `customNow` only affects the filler title, which `guideRows` uses for `kind = "live"` channels — the four Twitch channels are `kind = "live"` (created by the custom-channel API), so no other channel's text can be touched.

- [ ] **Step 4: run — all liveness tests green, tsc clean**

Run: `docker run … bun test tests/liveness.test.ts` → previous 8 + 4 new pass. `bun x tsc --noEmit` clean. Full suite unchanged otherwise.

- [ ] **Step 5: see it end to end**

With phospharr redeployed and Lofi Girl live, within ~15 s of a poll:
`curl -s "$E/LiveTv/Programs?ChannelIds=<lofi girl emby id>&UserId=$U&IsAiring=true&api_key=$K"` → `Name` is `Live now: <its current Twitch title>`, with no Emby refresh having run. (Find the Emby channel id with `GET /LiveTv/Channels?api_key=…` and match `Name == "Lofi Girl"`.)

- [ ] **Step 6: commit**

```bash
git add src/health/liveness.ts tests/liveness.test.ts
git commit -m "feat(liveness): Twitch stream title becomes the channel's 'Live now' guide text and pushes instantly

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** endpoint + Ping (T1, T4); Emby-identical ExternalId (T2); window-bounded prune, channels-not-in-batch untouched (T3, T4); never-throw handler (T4); "pushed == exported" (T5 makes it structural; T9 relies on it); `guidePush` default off + fallback (T6, T7); delta fingerprints, skipped-retry (T7); scheduler/manual-sync wiring (T8); idempotence with the nightly refresh (T8 gate); event trigger for Twitch titles (T9); install refuses with viewers (T1); SDK DLLs never committed (T1). Out of scope items (channels, icons, Jellyfin) have no tasks by design.
- **Known divergence from the spec, deliberate:** the spec listed `tunerUrl` in the request and an `epg.guidePushWindowHours` setting. Both are dropped: the plugin resolves channels by tvg-id (the tuner hash is not reproducible), and the push window must equal the export window (2 h behind / 48 h ahead) for the "pushed == exported" rule to hold, so a separate setting would only let them diverge.
- **Type consistency:** `ChannelBatch.TvgId/WindowStart/WindowEnd/Programs`, `ProgramDto.Start/End/Title/Subtitle/Description/Category/IsLive`, `ChannelResult.Created/Updated/Deleted/Skipped/Reason` are used identically in T3, T4 and the T7 client; `GuideProgram`/`guideRows` fields match between T5, T7 and T9; `pollOnce` return gains `changed` in T9 only.
