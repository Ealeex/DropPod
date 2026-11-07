# FireSend

A local recreation of FireSend's room-based file sharing, built with Express.

## Run

Requires Node.js 22.13 or newer.

```sh
npm ci
npm start
```

Open [FireSend](http://localhost:3001). For a second device on the same network, use the room link or QR code shown in the room. If the host has more than one network address, select the address for the shared network in the room. The second device must be able to reach port 3001 on the host.

Rooms last 24 hours and accept files up to 500 MB each. Anyone who has a room code and can reach the server can upload and download. The creator can list their room publicly on this server. The app uses plain HTTP and is intended for a trusted local network.

The server stores files and room metadata under `.data` by default. Set `FIRESEND_DATA_DIR` to use another directory. Expired rooms and their files are removed automatically while the server runs.

The local recreation includes Quick Share, public room browsing, and a TV browser view. The Lifetime Room card links to the original service.
