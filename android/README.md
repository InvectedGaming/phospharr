# Phospharr for Android (phone, tablet, Android TV, Fire TV)

A thin WebView shell around your Phospharr server. Android's WebView has full
Media Source Extensions, so the whole app — guide, live TV, DVR, VOD, mosaic —
runs exactly as it does in a browser. On first launch you enter your server
address (e.g. `http://192.168.1.10:7777`); it's remembered after that.

- **Fullscreen video** works (including on the TV leanback launcher).
- **Back** exits fullscreen → walks history → exits.
- **Long-press Back/Menu** re-opens the server-address screen.
- Cleartext HTTP is allowed for LAN self-hosting; HTTPS domains work too.

## Get the APK

Every push to `android/**` builds it in CI — grab `phospharr-apk` from the run's
artifacts (**Actions → Android APK**). Tagged releases (`v*`) also attach
`phospharr.apk` to the GitHub Release. Sideload it (enable "install unknown
apps"); no Play Store account required.

## Build locally

Needs JDK 17 + the Android SDK. From this folder:

```bash
gradle wrapper --gradle-version 8.7   # once, to create ./gradlew
./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

The release build is signed with the debug key so the APK is installable without
managing signing secrets. It is sideload-only — not a Play Store artifact.
