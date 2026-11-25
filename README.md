# Slate Sync Server

An optional sync server for Slate, the Markdown notes app for iPhone and Mac. Slate normally syncs through iCloud. If you'd rather not use iCloud, or can't (a work Mac, say), run this server yourself and point Slate at it. Your notes then sync between your devices through a machine you control.

Sync is **end-to-end encrypted**. Slate encrypts every file on your device, with a key made from a sync passphrase only you know, before anything is sent. The server only ever stores ciphertext under random-looking ids: it never sees note text, file names or folder names, and it can't decrypt anything. [How Slate encrypts](#how-slate-encrypts) below describes the format exactly, so you can check that claim.

- TypeScript on [Bun](https://bun.sh), with SQLite (`bun:sqlite`) and plain files. No other dependencies.
- One process and one data folder, so it is easy to back up.
- Accounts are made with a command on the server. There is no sign-up page.

## What the server knows

It knows your account name, how many objects you have, their sizes (roughly the sizes of your files) and when they change. It does not know what they are or what they're called. If you lose the passphrase, nobody can read the data on the server, you included.

## What you need

- A computer that stays on: a home server, a NAS that runs Docker, a small cloud VM, a Raspberry Pi.
- **Docker** (with Docker Compose), or **Bun** 1.1 or later if you'd rather run it directly.
- A way to reach it over **HTTPS** from your devices. Slate refuses plain `http://` except for addresses on your local network. See [HTTPS](#https).

## Quick start with Docker

```sh
git clone https://github.com/WesYarber/slate-sync-server.git
cd slate-sync-server
docker compose up -d --build
curl http://127.0.0.1:8787/v1/health        # {"ok":true}
```

The included `docker-compose.yml`:

```yaml
services:
  slate-sync:
    build: .
    restart: unless-stopped
    ports:
      - "127.0.0.1:8787:8787"
    environment:
      MAX_OBJECT_BYTES: "104857600"
      MAX_ACCOUNT_BYTES: "0"
    volumes:
      - slate-sync-data:/data

volumes:
  slate-sync-data:
    name: slate-sync-data
```

What each part does:

| | |
|---|---|
| `ports: "127.0.0.1:8787:8787"` | The server listens on port 8787, published **on this machine only**. Your HTTPS proxy or tunnel connects to it there. Use `"8787:8787"` only if the proxy runs on another machine. |
| `volumes: slate-sync-data:/data` | Everything the server stores (the database `slate-sync.sqlite` and the encrypted files in `blobs/`) is in this Docker volume. It survives rebuilds and updates. |
| `MAX_OBJECT_BYTES` | The largest single file, in bytes (default 100 MB). Larger files stay on the device and Slate says so. Keep it a little **under** your proxy's request-size limit (see [HTTPS](#https)). |
| `MAX_ACCOUNT_BYTES` | The most one account may store, in bytes. `0` means no limit. |

Inside the container, `DATA_DIR=/data`, `HOST=0.0.0.0` and `PORT=8787` are already set by the Dockerfile.

## Run it with Bun instead

```sh
bun run start        # listens on 127.0.0.1:8787, data in ./data
```

| Variable | Default | |
|---|---|---|
| `PORT` | `8787` | |
| `HOST` | `127.0.0.1` | `0.0.0.0` listens on every interface. |
| `DATA_DIR` | `./data` | Database (`slate-sync.sqlite`) and encrypted files (`blobs/`). |
| `MAX_OBJECT_BYTES` | `104857600` (100 MB) | Largest single file. |
| `MAX_ACCOUNT_BYTES` | `0` (no limit) | Most one account may store. |

To keep it running, a systemd unit is enough:

```ini
# /etc/systemd/system/slate-sync.service
[Unit]
Description=Slate sync server
After=network.target

[Service]
User=slate-sync
WorkingDirectory=/opt/slate-sync-server
Environment=DATA_DIR=/var/lib/slate-sync PORT=8787
ExecStart=/usr/local/bin/bun run src/server.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Make an account and a token

Each person gets an account, and each account has one or more tokens (think of a token as the account's password for the app). Run this on the server:

```sh
# Docker
docker compose exec slate-sync bun run admin create-account alice

# Bun
bun run admin create-account alice
```

It prints a token like `slate_3q2…`. **Copy it now**: it is shown once, and the server keeps only a hash of it. Other commands:

```sh
bun run admin new-token <name> [label]     # another token (one per device, if you like)
bun run admin revoke-tokens <name>         # every token of the account stops working (data stays)
bun run admin delete-account <name>        # the account and all its data
bun run admin list                         # accounts, token counts and storage used
```

(With Docker, put `docker compose exec slate-sync` in front of each.)

## Set up Slate

On each device, open **Settings › Sync** in Slate and enter:

1. **Sync server address**: your server's HTTPS address, for example `https://sync.example.com`.
2. **Token**: the token from `create-account` (or one from `new-token` for this device).
3. **Sync passphrase**: a passphrase you choose. It never leaves your devices; your notes are encrypted with a key made from it.

Use the **same passphrase on every device**. The first device to connect sets it, and a device with a different passphrase is told it's wrong rather than syncing. Write the passphrase down somewhere safe: there is no way to reset it, because the server never had it.

## HTTPS

Slate sends the token with every request, so the server must be behind HTTPS. Plain `http://` is only accepted for `localhost` and addresses on your own network. Two things matter for whatever you put in front:

- **Request size.** Uploads are as large as your largest file. Allow a bit more than `MAX_OBJECT_BYTES`.
- **Long requests.** Slate holds a request open for up to 55 seconds waiting for changes (see `wait` in the [API](#api)). Proxy timeouts must be longer than that. The defaults below already are.

**Caddy** (gets a certificate for you automatically):

```
sync.example.com {
	reverse_proxy 127.0.0.1:8787
	request_body {
		max_size 110MB
	}
}
```

**nginx:**

```nginx
server {
    listen 443 ssl;
    server_name sync.example.com;
    # ssl_certificate / ssl_certificate_key as usual

    client_max_body_size 110m;
    proxy_read_timeout 90s;

    location / {
        proxy_pass http://127.0.0.1:8787;
    }
}
```

**Cloudflare Tunnel** (no open ports on your router): add a public hostname such as `sync.example.com` that points at `http://127.0.0.1:8787` (or `http://slate-sync:8787` if `cloudflared` runs in the same Docker network). Cloudflare limits request bodies to 100 MB on its free plan, so set `MAX_OBJECT_BYTES` to about `94371840` (90 MB).

Check it from another device: `curl https://sync.example.com/v1/health` should print `{"ok":true}`.

## Back up

Everything is in the data folder (the `slate-sync-data` volume with Docker, `DATA_DIR` otherwise). Backups are exactly as encrypted as the live data: without the passphrase they can't be read.

The simplest consistent backup stops the server for a moment:

```sh
docker compose stop
docker run --rm -v slate-sync-data:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/slate-sync-$(date +%F).tar.gz -C /data .
docker compose start
```

To restore one (this replaces what is in the volume):

```sh
docker compose stop
docker run --rm -v slate-sync-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/slate-sync-2026-01-31.tar.gz -C /data'
docker compose start
```

Don't copy `slate-sync.sqlite` alone while the server is running: the database is in WAL mode and recent writes are in `slate-sync.sqlite-wal` beside it. To back up without stopping, take the database with `VACUUM INTO` (or `sqlite3 … ".backup …"`) first, then copy `blobs/`, skipping `*.tmp` files (uploads in progress).

## Update

```sh
cd slate-sync-server
git pull
docker compose up -d --build
```

`--build` matters: the code is built into the image, so a plain restart keeps running the old version. Your data is in the volume and is not touched. Devices waiting on a long request simply reconnect.

With Bun: `git pull`, then restart the service.

## API

All endpoints are under `/v1` and, except `/v1/health`, need `Authorization: Bearer <token>`.

| | |
|---|---|
| `GET /v1/health` | `{"ok": true}` |
| `GET /v1/account` | Name, object count, bytes used, limits, and `"wait": true` (this server supports `wait` on `/v1/changes`). |
| `GET /v1/changes?since=<cursor>&limit=<n>` | `{cursor, more, changes: [{id, version, size, deleted}]}`: every object changed after the cursor, latest state only. Start at 0; keep the returned cursor. |
| `GET /v1/changes?since=<cursor>&wait=<seconds>` | Same answer, but if nothing has changed yet, held open until an object in the account is PUT or DELETEd, or `wait` seconds pass (then `changes` is empty and the cursor unchanged). `wait` is whole seconds, clamped to 1–55 (under common proxy timeouts); `0` or absent answers at once. At most 16 held per account: past that, the oldest is answered at once, empty. A server that doesn't list `wait` in `/v1/account` ignores the parameter. |
| `GET /v1/objects/<id>` | The blob, with its version in `X-Version`. 404 if missing or deleted. |
| `PUT /v1/objects/<id>` | Store a blob. `X-Base-Version` must be the current version (0 for a new or deleted object). Returns the new version. |
| `DELETE /v1/objects/<id>` | `X-Base-Version` as above. Leaves a tombstone so other devices see the delete. |

A stale `X-Base-Version` gets **409** with the current `{version, deleted}`, so the client can merge and try again. Too large is **413**, a full account **507**, a missing `X-Base-Version` **428**. Object ids are 1–128 characters of `A–Z a–z 0–9 _ -`.

The server never interprets a blob: it stores the bytes it is given and hands them back.

## How Slate encrypts

For anyone checking the privacy claim or writing another client:

- **Key.** PBKDF2-HMAC-SHA256 (600,000 iterations, 16-byte random salt) turns the passphrase into a 32-byte master key. The salt, the iteration count and a check value are stored, unencrypted, as the object `slate-keyinfo` (JSON: `version`, `kdf`, `iterations`, `salt`, `check`, binary fields base64). The check is AES-GCM of `slate-sync-check` under the content key, with `slate-keyinfo` as additional data; it tells a wrong passphrase apart.
- **Subkeys.** HKDF-SHA256 over the master key, salt `slate-sync`, info `content` (for sealing) and `ids` (for naming), 32 bytes each.
- **Ids.** An object's id is the hex HMAC-SHA256 (with the ids key) of the file's path inside the notes folder, in Unicode NFC, with `/` separators. Every device finds the same file under the same id, and the server sees only the hash.
- **Objects.** `SLS1` followed by AES-256-GCM (12-byte nonce, ciphertext, 16-byte tag) of: the path's length (4 bytes, big-endian), the path (UTF-8), the file's bytes. The object id is the additional authenticated data, so the server can't swap one file for another.

The passphrase, the master key and the subkeys never leave the device.

## Develop

```sh
bun test
```

## License

MIT. See [LICENSE](LICENSE).
