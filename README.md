# FireSend

FireSend is a shared drive for a group on a trusted local network. The drive opens with a Shared drive category. Members can create, rename, and reorder categories. Files stay in the drive when the server restarts.

## Run

Requires Node.js 22.13 or newer.

```sh
npm ci
npm start
```

Open [FireSend](http://localhost:3001). On another device, use the host computer’s network address with port 3001.

After signing in, members can browse the drive, preview files, upload, download, create folders, rename items, and move or delete them. Changes appear automatically in open folders. FireSend does not set a per-file upload cap. Keep the server reachable only from the group’s trusted network. The default server uses HTTP.

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

Administrator accounts only exist in `account` mode. The first account registered on an empty drive becomes an active admin and is signed in automatically. To grant another registered account admin access, run this command on the host from the project folder, replacing `username` with that account’s username.

```sh
npm run grant-admin -- username
```

The command enables the account and grants it admin access. Sign in to see the Admin panel button. Admins can enable newly registered accounts, disable, re-enable, or delete member accounts, and view storage usage. Disabling a member revokes their sessions and blocks access until they are enabled again.

## Data

FireSend stores metadata and uploads under `.data` by default. Set `FIRESEND_DATA_DIR` to use a different directory, and use the same setting when granting admin access.
