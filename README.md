# FireSend

FireSend is a shared drive for a group on a trusted local network. The drive opens with a Shared drive category. Members can create, rename, and reorder categories, and delete added categories with their contents. Files stay in the drive when the server restarts.

## Run

Requires Node.js 22.13 or newer.

```sh
npm ci
npm start
```

Open [FireSend](http://localhost:3001). On another device, use the host computer’s network address with port 3001.

After signing in, members can browse the drive, preview files, upload, download, create folders, rename items, and move or delete them. Changes appear automatically in open folders. FireSend does not set a per-file upload cap. Keep the server reachable only from the group’s trusted network. The default server uses HTTP.

Drag a drive item onto another folder to move it there. In a subfolder, drop an item on the `..` row to move it up one level.

Images, audio, video, text, and PDFs can be previewed. Source files such as JavaScript, Python, and TypeScript get syntax coloring, and multi-page PDFs have page navigation. COLLADA (`.dae`), Wavefront (`.obj`), and FBX (`.fbx`) models open in a rotatable 3D view. FBX models can use embedded textures. Keep external textures and any OBJ material files (`.mtl`) in the same drive folder. `.zip` and `.7z` archives open as a browsable file list, and previewable entries can be opened from there. Archive browsing uses the 7-Zip command-line tool on the host. Set `SEVEN_ZIP_PATH` if `7z` is not in a standard location.

Drag the left edge of the preview drawer to resize it, or click outside to close it. The drive list shows small image and video thumbnails. Video thumbnails use a frame 25% into the clip when its duration is available. FFmpeg generates these thumbnails and browser-compatible previews for uploaded formats such as MOV, MKV, AVI, FLAC, and TIFF. The first preview of a large file can take time to generate. The server uses FFmpeg and FFprobe from `tools/ffmpeg/bin` when present, or from the host's PATH. A fresh checkout needs its own copy of those tools.

## Configuration

Edit `config.jsonc` in the project folder and restart the server:

```jsonc
{
  // Theme used on first visit: "vista" or "graphite".
  "default-theme": "vista",

  // How people authenticate to the drive.
  "auth-mode": "account"
}
```

- `default-theme`: `vista` (default) or `graphite`. Members can change the theme in Settings, and their choice is remembered in the browser.
- `auth-mode`: choose one of the following.
  - `account`: members register and sign in with a username and password, and admins approve accounts. This is the default.
  - `passphrase`: everyone enters one shared passphrase before using the drive. Set `PASSPHRASE` in `.env` (copy `.env.example`) or in the environment. The server refuses to start if the passphrase is missing. `.env` is ignored by Git.
  - `ip`: the first visit from a network address registers a friendly name and passphrase. Later visits from the same address only ask for that passphrase. Sessions are tied to the address, so a different address registers its own name and passphrase.

Restart the server after changing the file.

## Set up an admin

In `account` and `ip` modes, the first registered account becomes the administrator. An existing IP-mode drive gives this role to its earliest registration. The IP-mode admin can rename or delete member accounts and set a temporary passphrase. The member must replace it before accessing the drive.

In `account` mode, you can also grant another registered account admin access. Run this command on the host from the project folder, replacing `username` with that account’s username.

```sh
npm run grant-admin -- username
```

The command enables the account and grants it admin access. Sign in to see the Admin panel button. Admins can enable newly registered accounts, disable, re-enable, or delete member accounts, and view storage usage. Disabling a member revokes their sessions and blocks access until they are enabled again.

Use **Settings → Sign-in** to change your password or passphrase. In shared-passphrase mode, `PASSPHRASE` supplies the initial value. Changes made in Settings are stored with the drive data and sign out everyone else using that shared passphrase.

## Data

FireSend stores metadata and uploads under `.data` by default. Set `FIRESEND_DATA_DIR` to use a different directory, and use the same setting when granting admin access.
