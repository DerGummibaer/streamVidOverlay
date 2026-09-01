# Stream Overlay

Mod control panel + transparent stream overlay. Mods visit the site, you load
the `#overlay` URL in OBS or the desktop app.

## Setup

### 1. Firebase (free real-time sync)

1. Go to https://console.firebase.google.com
2. Click **Add project**, give it any name, skip Google Analytics
3. In the left sidebar go to **Build → Realtime Database**
4. Click **Create database**, choose any region, start in **test mode**
5. Copy the database URL — it looks like:
   `https://your-project-default-rtdb.firebaseio.com`
6. Open `src/App.jsx` and paste it into the `FIREBASE_URL` constant

### 2. Change the password

In `src/App.jsx`, change `MOD_PASSWORD` from `streammod2024` to something only your mods know.

### 3. Push to GitHub

1. Create a new repo on GitHub (e.g. `stream-overlay`) — make it public
2. Run these commands in this folder:
   ```
   git init
   git add .
   git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/stream-overlay.git
   git push -u origin main
   ```

### 4. Enable GitHub Pages

1. Go to your repo on GitHub → **Settings → Pages**
2. Under **Source**, select **GitHub Actions**
3. Wait about 60 seconds, then your site is live at:
   `https://YOUR_USERNAME.github.io/stream-overlay/`

> If your repo has a different name, update the `base` in `vite.config.js` to match.

### 5. Update the Tauri app

Put this URL in your desktop overlay app:
```
https://YOUR_USERNAME.github.io/stream-overlay/#overlay
```

### 6. OBS browser source

Add a browser source in OBS with the same `#overlay` URL, sized to your canvas (e.g. 1920×1080).

## URLs

| URL | Purpose |
|-----|---------|
| `https://yourname.github.io/stream-overlay/` | Mod control panel |
| `https://yourname.github.io/stream-overlay/#overlay` | Transparent overlay (OBS + desktop app) |

## Locking down Firebase

Once everything works, tighten the Firebase security rules so random people
can't write to your overlay. In the Firebase console, go to
**Realtime Database → Rules** and paste:

```json
{
  "rules": {
    "overlay": {
      ".read": true,
      ".write": true
    }
  }
}
```

For a fully locked-down setup, you'd add Firebase Auth — but for a private
mod tool this is fine as long as the URL isn't public.
