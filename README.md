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

To upload, drop files and folders from your computer into the drive together, or use **Upload files** and **Upload folder**. A drop preserves nested folders, including empty ones. Uploads merge into matching folders and report duplicate files without overwriting them.

Use **Download** on a file or folder. FireSend packs folders into ZIP files with 7-Zip at medium compression. The **Transfers** widget shows upload, compression, and download progress with an estimated time remaining as data becomes available. ZIP entries with Windows-incompatible names use safe substitutes.

Use **Copy share link** on a file or folder to create a direct download link. Anyone who can reach the FireSend server and has the link can download without signing in. To share with another device, open FireSend using the host's network address before copying the link. Folder links download a ZIP of the folder's current contents, and deleting the shared item disables its links.

Images, audio, video, text, and PDFs can be previewed. Source files such as JavaScript, Python, and TypeScript get syntax coloring, and multi-page PDFs have page navigation. COLLADA (`.dae`), Wavefront (`.obj`), and FBX (`.fbx`) models open in a rotatable 3D view. FBX models can use embedded textures. Keep external textures and any OBJ material files (`.mtl`) in the same drive folder. `.zip` and `.7z` archives open as a browsable file list, and previewable entries can be opened from there.

Drag the left edge of the preview drawer to resize it, or click outside to close it. The drive list shows small image and video thumbnails. Video thumbnails use a frame 25% into the clip when its duration is available. FFmpeg generates these thumbnails and browser-compatible previews for uploaded formats such as MOV, MKV, AVI, FLAC, and TIFF. The first preview of a large file can take time to generate.

### Host tools

Install FFmpeg and 7-Zip on the computer running the FireSend server. On macOS, use Homebrew. [FFmpeg formula](https://formulae.brew.sh/formula/ffmpeg) and [7-Zip formula](https://formulae.brew.sh/formula/sevenzip).

```sh
brew install ffmpeg sevenzip
```

FireSend looks for `ffmpeg`, `ffprobe`, and `7zz` or `7z` on the host. It also checks Homebrew's standard bin directories on macOS. Set `FFMPEG_PATH`, `FFPROBE_PATH`, or `SEVEN_ZIP_PATH` in `.env` to point to an executable in a custom location.

On Linux and macOS, FireSend checks these tools at startup. If a tool is missing or cannot run, the server log lists it and gives an install command for Homebrew or the detected Linux distribution. FireSend still starts, so you can install the tools and restart it when ready.

On Windows, FireSend can use `tools/7z.exe` with the adjacent `7z.dll`, and `ffmpeg.exe` and `ffprobe.exe` under `tools/ffmpeg/bin`. The included Windows 7-Zip pair is version 26.05 for x64. See `tools/7zip-LICENSE.txt` and the [upstream downloads](https://www.7-zip.org/download.html).

For a self-contained release, ship native tools and their required libraries in separate platform builds. FireSend checks `tools/<platform>-<arch>/` for bundled executables, such as `tools/darwin-arm64/` for Apple Silicon and `tools/darwin-x64/` for Intel Macs. Restart FireSend after installing or replacing the tools.

### Blender previews

The 3D preview opens in **Orbit** mode. Choose **Fly** for WASD movement, R/F to rise and descend, and adjustable speed. Click the scene to capture the mouse or drag to look around. Press Escape to release the mouse.

**Windows with Ubuntu WSL.** Open Ubuntu on x86-64 and install Bubblewrap and [uv](https://docs.astral.sh/uv/getting-started/installation/). From the FireSend project directory inside Ubuntu, run:

```sh
sudo apt install bubblewrap
bash tools/blender-preview/setup-wsl.sh
```

Set `BLENDER_PREVIEW_WSL_DISTRO=Ubuntu` in `.env` and restart FireSend. Use your distribution’s actual name from `wsl --list --quiet`. The setup installs the Linux Blender runtime into the project’s ignored `tools/blender-runtime` folder. FireSend runs it in a Bubblewrap sandbox without access to the drive files or network. On Windows, the WSL setting takes precedence when both runners are configured.

**Docker.** Build the converter on the FireSend host with Docker running in Linux-container mode.

```sh
docker build --platform linux/amd64 -t firesend-blender-preview ./tools/blender-preview
```

Set `BLENDER_PREVIEW_IMAGE=firesend-blender-preview` in `.env` and restart FireSend. Set `DOCKER_PATH` if Docker is outside the server’s PATH. ARM hosts need Docker’s AMD64 emulation for this image.

FireSend converts the active scene to GLB on the first preview and caches it for later views. Pack textures into the Blender file before uploading. Both runners receive the upload through a pipe, disable automatic Blender scripts, and limit conversion to 60 seconds and 128 MiB each for the upload and resulting GLB.

## Configuration

Edit `config.jsonc` in the project folder and restart the server:

```jsonc
{
  // Theme used on first visit: "vista" or "graphite".
  "default-theme": "vista",

  // How people authenticate to the drive.
  "auth-mode": "account",
  "trusted-proxies": []
}
```

- `default-theme`: `vista` (default) or `graphite`. Members can change the theme in Settings, and their choice is remembered in the browser.
- `auth-mode`: choose one of the following.
  - `account`: members register and sign in with a username and password, and admins approve accounts. This is the default.
  - `passphrase`: everyone enters one shared passphrase before using the drive. Set `PASSPHRASE` in `.env` (copy `.env.example`) or in the environment. The server refuses to start if the passphrase is missing. `.env` is ignored by Git.
  - `ip`: the first visit from a network address registers a friendly name and passphrase. Later visits from the same address only ask for that passphrase. Sessions are tied to the address, so a different address registers its own name and passphrase.

Restart the server after changing the file.

### NGINX reverse proxy

Add the IP addresses or CIDRs of your reverse proxies to `trusted-proxies`. The default empty list uses the direct connection address.

For IP mode with NGINX and FireSend on the same host, add these settings to `config.jsonc`.

```jsonc
{
  "auth-mode": "ip",
  "trusted-proxies": ["127.0.0.1"]
}
```

Put this location block in the NGINX server block that serves FireSend.

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
}
```

Restart FireSend and reload NGINX. The FireSend sign-in screen should show the client's IP address.

Use NGINX's actual address as seen by FireSend if it runs on another machine or in a container. FireSend reads `X-Forwarded-For` through the trusted proxy chain and uses `X-Real-IP` as a fallback when that header is absent. IP-mode registrations are tied to the address on record. A person previously registered under the proxy's address will need to register from their own forwarded address.

## Set up an admin

In `account` and `ip` modes, the first registered account becomes the administrator. An existing IP-mode drive gives this role to its earliest registration. The IP-mode admin can rename or delete member accounts and set a temporary passphrase. The member must replace it before accessing the drive.

In `account` mode, you can also grant another registered account admin access. Run this command on the host from the project folder, replacing `username` with that account’s username.

```sh
npm run grant-admin -- username
```

The command enables the account and grants it admin access. Sign in to see the Admin panel button. Admins can enable newly registered accounts, disable, re-enable, or delete member accounts, and view storage usage. Disabling a member revokes their sessions and blocks access until they are enabled again.

In IP mode, use the connecting address shown on the sign-in screen in place of the username. The address must be registered first. This lets you grant admin access to a new client address after setting up a reverse proxy.

Use **Settings → Sign-in** to change your password or passphrase. In shared-passphrase mode, `PASSPHRASE` supplies the initial value. Changes made in Settings are stored with the drive data and sign out everyone else using that shared passphrase.

## Data

FireSend stores metadata and uploads under `.data` by default. Set `FIRESEND_DATA_DIR` to use a different directory, and use the same setting when granting admin access.
