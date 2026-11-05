# The Android app: a Trusted Web Activity

A Trusted Web Activity (TWA) puts the website in an Android app: full screen, with no browser bar,
run by the phone's own Chrome. Digital Asset Links prove that the app and the site belong
together. Push already works on Android's web, so the app adds one thing: a listing on Google
Play.

The app isn't built or published. The link file's template is
[`docs/online/assetlinks.json.example`](assetlinks.json.example).

## The package name

**`xyz.hexplorers.app`** in the template and below: the site's domain (`hexplorers.xyz`)
reversed, as Android expects. Choose before the first upload: the name can never change once the
app is on Play. (The ID needn't match the domain; the asset links below must be served from the
domain the app opens.)

## What the site gives the app

- **The manifest.** `id` and `start_url` are `/`, and `display` is `fullscreen`, which a TWA
  shows as an immersive app. There are icons (512 px, and a maskable one), the colours and
  `shortcuts`, which become the app's long-press shortcuts (Singleplayer and Multiplayer; Bubblewrap takes up to four).
- **The service worker** (`public/sw.js`). An app launched offline opens the saved page, and solo
  play works against the crew. Chrome's TWA quality checks expect an offline launch to show
  something other than an error.
- **Notifications.** With Bubblewrap's notification delegation, Web Push shows as the app's
  own. On Android 13 and later the app asks for the notification permission itself.

## Building it with Bubblewrap

Bubblewrap is Google's command-line tool for TWAs. It isn't a dependency of the game: install it
globally and keep the Android project in a folder of its own, outside this repository.

1. **Prerequisites.** You need Node, a JDK 17 and the Android SDK, a Google Play developer
   account, and a phone with USB debugging for testing. Bubblewrap offers to download the JDK and
   the SDK on its first run.
2. Install Bubblewrap: `npm i -g @bubblewrap/cli`.
3. In a new folder (for example `~/Projects/exploratory-android`), run
   `bubblewrap init --manifest=https://hexplorers.xyz/manifest.webmanifest`. It reads the
   manifest, so most answers are already filled in. Check these:
   - Domain: `hexplorers.xyz`. URL path: `/`.
   - Application name and short name: `Hexplorers`.
   - Application ID: `xyz.hexplorers.app`.
   - Display mode: `fullscreen`. Orientation: `default` (the manifest's `any`).
   - Status bar colour `#ecdcb6` (the theme colour). Splash background `#1d5995`.
   - Icons: `/icon-512.png`, maskable `/icon-maskable-512.png` and monochrome `/badge-96.png`.
   - Include support for notifications: **yes** (notification delegation).
   - Shortcuts: **yes**.
   - Signing key: **create a new one**, `./android.keystore`, alias `android` (see
     [Signing](#signing)).
   - Version code `1`, version name `1.0.0`.

   This writes `twa-manifest.json`, the project's settings. Keep it with the keystore.
4. Run `bubblewrap build`. It makes `app-release-bundle.aab`, which goes to Play, and
   `app-release-signed.apk`, for testing on a phone.
5. Run `bubblewrap install` to put the APK on a phone over adb. Until the link file below is
   deployed, the app shows Chrome's URL bar at its top: that bar is the sign that the link isn't
   verified.

## Signing

- **Use Play App Signing.** It's the default for a new app. Google keeps the *app signing key*,
  which signs what players install. You keep the *upload key* (`android.keystore`), which only
  proves an upload is yours. If the upload key is lost, Play support can reset it, but the app
  signing key never leaves Google.
- **Never commit the keystore** or its passwords to this repository. Keep the keystore,
  `twa-manifest.json` and the passwords together in a password manager or a private store.
- Both keys' fingerprints go in the link file:
  - the **upload key's** SHA-256, so a sideloaded test build is verified. Get it with
    `keytool -list -v -keystore android.keystore -alias android`;
  - the **app signing key's** SHA-256, so the Play install is verified. Get it after the first
    upload (an internal testing track will do), from Play Console: *Test and release* → *App
    integrity* → *App signing*.

## The link file (Digital Asset Links)

1. Copy `docs/online/assetlinks.json.example` to `public/.well-known/assetlinks.json` (making the
   folder) and put both fingerprints in its list, in the form `AB:CD:…` (32 pairs).
   `bubblewrap fingerprint add <sha256>` followed by `bubblewrap fingerprint generateAssetLinks`
   writes the same file.
2. Build and deploy the site. Vite copies `public/` as it is, `.well-known` included. Check it:
   `curl -i https://hexplorers.xyz/.well-known/assetlinks.json` should return 200 and JSON.
   (Workers static assets upload dot-folders. If it ever 404s, the assets settings in
   `wrangler.toml` are where to look.)
3. Check the link with Google's
   [Statement List Generator and Tester](https://developers.google.com/digital-asset-links/tools/generator),
   then open the app again: the URL bar should be gone.

## Before the Play listing

On a phone, check:
- full screen, with no URL bar;
- an offline launch (airplane mode) opens the game, and solo play works;
- a "your move" push shows as Hexplorers and opens the game;
- the shortcuts work on a long press.

The listing itself needs phone screenshots (the manifest's screenshots are wide ones, for desktop
install dialogs), a content rating (a board game with dice, and no real-money gambling), a privacy
policy URL and the data safety form. Guest play collects nothing; an account may add an email
address.

## Updates

The app *is* the website: a deploy updates it, with no Play release. Rebuild (`bubblewrap update`,
then `bubblewrap build`, with the version code raised) only for these:
- a change to what `twa-manifest.json` holds: the name, the icons, the colours or the shortcuts;
- Play raising its minimum target SDK, about once a year.
