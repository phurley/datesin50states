# Dates in 50 States

Patrick & Susan's road-trip blog: dates in every state, by Class A motorhome.

- **Public:** a vintage map of the USA. States with at least one entry are colored and clickable, and each opens a "Greetings from…" page with its entries and photos.
- **Authors:** Patrick and Susan sign in with Apple. Clicking any state opens an editor where they can write entries, drag in photos, or link an iCloud shared album. Nobody else can sign in.

Stack: Node 22+ / Express, SQLite (built-in `node:sqlite`), `sharp` for image resizing, server-rendered HTML with vanilla JS for the map and the editor. No build step.

## Run locally

```bash
npm install
npm run dev            # http://localhost:3050, data in ./data
```

`npm run dev` turns on a **Dev sign-in** button on `/login` so you can act as Patrick or Susan without Apple. It is ignored when `NODE_ENV=production`.

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `SITE_URL` | `http://localhost:$PORT` | Public origin. Used for the Apple return URL and the origin check on writes |
| `PORT` / `HOST` | `3050` / `127.0.0.1` | Listen address |
| `DATA_DIR` | `./data` | SQLite DB (`dates.db`), `media/` photos, `backups/` |
| `APPLE_CLIENT_ID` | — | Sign in with Apple **Services ID** (`com.datesin50states.signin`) |
| `AUTHOR_EMAILS` | `phurley@gmail.com:Patrick,sue.hurley@gmail.com:Susan` | Who can write (`email:Name`, comma separated) |
| `DEV_LOGIN` | off | `1` enables dev sign-in (non-production only) |

In production these live in `/etc/datesin50states.env` on the server.

## Sign in with Apple

These are already set up in Apple Developer (team `87EUDMJ2TV`):

- App ID `com.datesin50states.web` with *Sign In with Apple* enabled
- Services ID `com.datesin50states.signin`, with domain `datesin50states.com` and return URL `https://datesin50states.com/auth/apple/callback`

The site uses Apple's `form_post` flow and verifies the `id_token` against Apple's public keys (`appleid.apple.com/auth/keys`), checking issuer, audience = Services ID, and a per-login nonce. It never calls Apple's token endpoint, so **no private key or client secret is needed**.

Who gets in:

1. If the Apple user id (`sub`) is already bound to an author, they're signed in.
2. Otherwise, if Apple returns a verified email on the allow-list, that author is bound to this `sub` on first sign-in.
3. Anyone else sees "Not on the guest list", which shows their `sub`.

If an Apple ID uses *Hide My Email*, or its email isn't one of the Gmail addresses, the first sign-in is rejected and shows the `sub`. Bind it on the server:

```bash
ssh root@datesin50states.com
cd /opt/datesin50states/current
sudo -u dates env $(cat /etc/datesin50states.env | xargs) node scripts/authorize.js <sub> Susan
sudo -u dates env $(cat /etc/datesin50states.env | xargs) node scripts/authorize.js --list
```

## Photos

Two ways to add them, both from the editor:

1. **Upload.** Click the drop zone and pick **Photos** under *Media* in the file picker's sidebar to choose straight from the library (on iPhone it opens the photo library), or drop image files from Finder. Dragging directly out of Photos.app can crash Photos in some browsers (it fails while handing over the "promised" file), so use the picker instead. The browser shrinks big images and converts HEIC to JPEG in Safari. The server then makes a 2000px JPEG and a 640px WebP thumbnail.
2. **iCloud album link.** Paste the album's share link into the entry:
   - **Shared Collections** (`https://photos.icloud.com/shared/album/…`, the current Photos default) are **linked, not imported**. Their photos are encrypted and only decrypted inside Apple's web page, so the server can't fetch them. The entry shows "See “<album title>” in iCloud Photos →", with the title read from CloudKit's public share lookup. Add the photos you want shown via the picker.
   - **Classic Shared Albums with Public Website** (`https://www.icloud.com/sharedalbum/#…`) are imported. The server downloads the photos (videos skipped) and caches them, because iCloud's image URLs expire, and **Sync album now** picks up additions. This uses the unofficial endpoints the old album page uses.

★ on a photo in the editor makes it the entry's cover (used on the home page postcards).

**On the map**, a visited state is filled with one of its photos, cropped to the state's outline. 🗺 on a photo in the editor picks it for that state (click again to unpick). Without a pick, the state uses the newest entry's cover, then any photo. If it has no photos at all, it shows its **default illustration**: a vintage national-park-poster image of the state's signature park or attraction, in `public/img/states/XX.webp`. Postcards for entries without photos use the same illustration.

The illustrations are a single committed set, generated once with Gemini (`gemini-3.1-flash-image`). The subject for each state is listed in `lib/state-attractions.json`. To redo one, or all missing ones:

```bash
GEMINI_API_KEY=... node scripts/gen-state-art.js KY      # regenerate Kentucky
GEMINI_API_KEY=... node scripts/gen-state-art.js         # fill in any missing states
```

**On the state page**, the header uses the same illustration as a faded backdrop and fills the state stamp with it.

**The map tour.** A faint ▶ in the map's bottom-right corner starts a tour: the map gently zooms to each entry's state in date order (oldest first) and loops. The ‹ date › control steps back and forth, clicking the date pauses or resumes, and × (or Esc) zooms back out.

**On the home page**, the "Latest from the road" postcards slowly crossfade through each entry's photos, starting with the cover and showing up to 10.

## Deploy

The server is `root@datesin50states.com` (Ubuntu 24.04, shared with allisonhurley.com). The app runs as system user `dates` behind the nginx that's already there.

| Path | What |
|---|---|
| `/opt/datesin50states/releases/<utc>-<sha>` | Each deploy (newest 5 kept) |
| `/opt/datesin50states/current` | Symlink to the live release |
| `/var/lib/datesin50states/` | `dates.db`, `media/`, `backups/` (**back this up**) |
| `/etc/datesin50states.env` | Config |
| `datesin50states.service` | systemd unit (port 3050, loopback only) |
| `/etc/nginx/sites-available/datesin50states.conf` | vhost; serves `/media` directly; TLS via certbot |
| `/etc/cron.d/datesin50states-backup` | Nightly `VACUUM INTO` DB snapshot, 30 kept |

**First time (idempotent):**

```bash
./deploy/provision.sh              # user, dirs, env file, systemd, nginx, Let's Encrypt cert
# WITH_WWW=1 ./deploy/provision.sh # after the DNS record below exists: https cert for www
```

**Subdomains:** Namecheap DNS has (or should have) a wildcard A record, `*` → `138.197.22.230`. nginx (`deploy/nginx-redirect.conf`) sends every `http://<sub>.datesin50states.com` to the apex. HTTPS redirects only work for names with a certificate, which is just `www` (`WITH_WWW=1`). Other subdomains redirect over http only.

**Every release:**

```bash
git commit ... && git push
./deploy/deploy.sh                 # ships HEAD via git archive, npm ci, restart, health-check /healthz
ROLLBACK=1 ./deploy/deploy.sh      # back to the previous release
```

**Handy:**

```bash
ssh root@datesin50states.com journalctl -u datesin50states -f     # logs
ssh root@datesin50states.com systemctl restart datesin50states
```

## Map data

`lib/usa-states.json` is generated from [us-atlas](https://github.com/topojson/us-atlas) (Albers USA, with Alaska and Hawaii inset) by `npm run build:map`, and it's committed, so production needs no dev dependencies.
