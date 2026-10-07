# Sirtuti

Dimensioned sketches for site visits. Draw rooms, lots and other elements, enter their measurements, and get the area and perimeter of every shape plus a total. Built for price quotes (painting, flooring, etc.): a fast, clean estimate, not a survey.

The app UI is in Hebrew (RTL).

**Web app:** https://joka-7.github.io/Sirtuti/
**Desktop installers:** see [Releases](https://github.com/joka-7/Sirtuti/releases)

## Features
- Ready-made shapes: rectangle, triangle, trapezoid, regular polygon, L-shape, circle, dimension line, and a free polygon defined by side lengths and angles.
- Hand drawing: point by point or freehand, with automatic straightening. Close the shape at the start point or leave it as an open line.
- Drag, rotate, snap to other shapes' corners, duplicate, undo/redo, bring to front / send to back.
- Area and perimeter per shape (each can be hidden), an area summary that can be copied as text.
- Export to PNG with all dimensions and an area table.
- Optional Google sign-in (Firebase) to sync sketches across devices.
- Backup/restore of all sketches to a JSON file.
- Works offline and installs as a PWA on phones and desktops.

## Install
- **Android / desktop Chrome or Edge:** open the web app → browser menu → *Install app*.
- **iPhone:** open in Safari → Share → *Add to Home Screen*.
- **Desktop app:** download the installer for Windows (`.msi` / `.exe`), macOS (`.dmg`) or Linux (`.AppImage` / `.deb`) from Releases. The builds are not code-signed, so Windows SmartScreen and macOS Gatekeeper will warn on first launch (macOS: right-click the app → *Open*).

## Where sketches are stored
- **Without sign-in:** only on the device (browser storage, or the desktop app's own storage).
- **Signed in with Google (web app):** on the device and in Firestore under `users/<uid>/sketches`, synced across devices. Works offline and syncs when back online.
- Google sign-in is not available inside the desktop app (Google blocks sign-in from embedded webviews). Use the installed web app for sync, or move sketches with backup files.

## Setting up Google sign-in (Firebase)
Without this step the app runs fine, just without the account button.

1. Create a project at https://console.firebase.google.com (the free Spark plan is enough).
2. **Build → Authentication → Get started → Sign-in method:** enable **Google**.
3. **Authentication → Settings → Authorized domains:** add `joka-7.github.io` (and `localhost` for local testing).
4. **Build → Firestore Database → Create database** (production mode), then paste the contents of [`firestore.rules`](firestore.rules) into the **Rules** tab and publish.
5. **Project settings → Your apps → Add app → Web.** Copy the `firebaseConfig` object into [`web/firebase-config.js`](web/firebase-config.js) as `window.SIRTUTI_FIREBASE = { ... }`.
6. Commit and push. The Pages workflow redeploys the web app.

The Firebase web config is not a secret; access is enforced by the Firestore rules.

## Project layout
```
web/                         The app (static, no build step)
  index.html                 Entire UI: HTML, CSS and JS
  firebase-config.js         Firebase web config (null = no sign-in)
  vendor/firebase.js         Bundled Firebase SDK (auth + firestore)
  sw.js                      Service worker for offline use
  manifest.webmanifest       PWA manifest
  icons/
src-tauri/                   Desktop app (Tauri 2) wrapping web/
tools/firebase-entry.js      Entry for the Firebase bundle
firestore.rules              Firestore security rules
.github/workflows/
  pages.yml                  Deploys web/ to GitHub Pages on push to main
  release.yml                Builds desktop installers on tag push (v*)
```

## Development
```bash
npm install
npm run dev                  # serve web/ at http://localhost:8000
npm run tauri dev            # run the desktop app (needs Rust + Tauri prerequisites)
npm run build:firebase       # rebuild web/vendor/firebase.js after upgrading firebase
```
Tauri prerequisites: https://v2.tauri.app/start/prerequisites/

## Releasing
1. Bump the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`.
2. Bump `VERSION` in `web/sw.js` so installed PWAs pick up the new files.
3. Push to `main` (web app deploys automatically), then tag: `git tag v0.2.0 && git push origin v0.2.0`.
4. The release workflow builds the installers into a draft release. Review it and click *Publish*.

## License
MIT
