# FireSend

FireSend is a shared drive for a group on a trusted local network. The drive opens with a Shared drive category. Members can create, rename, and reorder categories. Files stay in the drive when the server restarts.

## Run

Requires Node.js 22.13 or newer.

```sh
npm ci
npm start
```

Open [FireSend](http://localhost:3001). On another device, use the host computer’s network address with port 3001.

After the first account, new members register and wait for an admin to enable their account. Sign in to browse the drive, preview files, upload, download, create folders, rename items, and move or delete them. Changes appear automatically in open folders. FireSend does not set a per-file upload cap. Keep the server reachable only from the group’s trusted network. The default server uses HTTP.

## Set up an admin

The first account registered on an empty drive becomes an active admin and is signed in automatically. To grant another registered account admin access, run this command on the host from the project folder, replacing `username` with that account’s username.

```sh
npm run grant-admin -- username
```

The command enables the account and grants it admin access. Sign in to see the Admin panel button. Admins can enable newly registered accounts, disable, re-enable, or delete member accounts, and view storage usage. Disabling a member revokes their sessions and blocks access until they are enabled again.

## Data

FireSend stores metadata and uploads under `.data` by default. Set `FIRESEND_DATA_DIR` to use a different directory, and use the same setting when granting admin access.
