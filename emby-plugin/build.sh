#!/bin/bash
# Build in the .NET 8 SDK container (there is no dotnet on this host).
# NOTE: never mount anything at /lib inside the container — it shadows the
# system libraries and dotnet fails with "no such file or directory".
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[[ -f "$HERE/lib/VERSION" ]] || { echo "run fetch-sdk.sh first" >&2; exit 1; }
VER=$(cat "$HERE/lib/VERSION")
if [[ "${1:-}" == "test" ]]; then
  exec docker run --rm -v "$HERE":/src -w /src/Emby.Phospharr.Tests mcr.microsoft.com/dotnet/sdk:8.0 \
    dotnet test -p:EmbySdkDir=/src/lib/emby-$VER -v q
fi
docker run --rm -v "$HERE":/src -w /src/Emby.Phospharr mcr.microsoft.com/dotnet/sdk:8.0 \
  dotnet publish -c Release -o /src/out --no-self-contained -p:EmbySdkDir=/src/lib/emby-$VER -v q
ls -la "$HERE/out/Emby.Phospharr.dll"
