# Dates in 50 States

Patrick & Susan's road-trip blog: dates in every state, by Class A motorhome.

- **Public:** a vintage map of the USA. States with at least one entry are colored and clickable, and each opens a "Greetings from…" page with its entries and photos.
- **Maps:** Patrick & Susan's map is the home page. Anyone with a join code can sign in (Apple or Google) and get their own map at a three-word address like `/rapid-crawling-elk/`. There's no search or directory of maps.
- **Authors:** a map's members click any state to write entries, add photos, or link an iCloud shared album. Partners join a map by scanning a QR code from its profile page.

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
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google OAuth web client. The Google button hides until both are set |
| `AUTHOR_EMAILS` | `phurley@gmail.com:Patrick,sue.hurley@gmail.com:Susan` | Admins: no limits, the root map (`email:Name`, comma separated) |
| `TYPESAFE_API_KEY` | — | Jev (typesafe.ai): checks names, addresses, and map text. Unset = no text checks |
| `GOOGLE_VISION_API_KEY` | — | Cloud Vision SafeSearch: checks photos. Unset = no photo checks |
| `TEXT_FLAG_AT` / `PHOTO_STRIKES_ALLOWED` | `0.6` / `10` | Jev score that refuses text; refused photos allowed before an account is blocked |
| `FREE_PHOTO_LIMIT` / `FREE_PHOTO_BYTES` | `100` / `1572864` | Free-tier photos per map, and max stored size per photo |
| `DEV_LOGIN` | off | `1` enables dev sign-in (non-production only) |

In production these live in `/etc/datesin50states.env` on the server.

## Sign in with Apple

These are already set up in Apple Developer (team `87EUDMJ2TV`):

- App ID `com.datesin50states.web` with *Sign In with Apple* enabled
- Services ID `com.datesin50states.signin`, with domain `datesin50states.com` and return URL `https://datesin50states.com/auth/apple/callback`

The site uses Apple's `form_post` flow and verifies the `id_token` against Apple's public keys (`appleid.apple.com/auth/keys`), checking issuer, audience = Services ID, and a per-login nonce. It never calls Apple's token endpoint, so **no private key or client secret is needed**.

**Google** uses the standard authorization-code flow with PKCE (`/auth/google`, return URL `https://datesin50states.com/auth/google/callback`) and verifies the `id_token` against Google's keys. Create an OAuth *Web application* client in Google Cloud Console with that redirect URI and only the `openid email profile` scopes, then put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `/etc/datesin50states.env` and restart.

Who gets in (`finishSignIn` in `server.js`):

1. A known Apple or Google id signs in to its account.
2. Patrick and Susan (admins in `AUTHOR_EMAILS`) are bound by verified email on their first sign-in with each provider. Email is never used to match anyone else.
3. Someone who scanned a map's invite QR within 30 minutes joins that map.
4. Anyone else is asked for a **join code**, then gets a new map with a random slug.

Accounts are linked to a second provider from the profile page (Connect Apple / Connect Google), not by matching emails.

Apple returns sign-ins as a cross-site POST, which doesn't carry our `SameSite=Lax` cookies, so `/auth/apple/callback` verifies the token and hands off to `/auth/finish/:token` (same-site) to finish.

If an admin's Apple ID uses *Hide My Email*, bind it on the server:

```bash
ssh root@datesin50states.com
cd /opt/datesin50states/current
sudo -u dates env $(cat /etc/datesin50states.env | xargs) node scripts/authorize.js <sub> Susan
sudo -u dates env $(cat /etc/datesin50states.env | xargs) node scripts/authorize.js --list
```

`npm run dev` adds two dev sign-in buttons: one for Patrick or Susan, and one that creates a brand-new person, to test join codes and invites.

## Maps, members, and limits

- **Root map:** Patrick & Susan's, shown at `/` and also at its own slug. Its members are admins.
- **Addresses:** new maps get `adjective-verb-animal` (`lib/slugs.js`, about 1.6M combinations). Members can rename the address on `/profile`; old addresses 301 to the new one (`slug_history`). App paths like `api`, `login`, `profile` are reserved. Unknown addresses are rate-limited per IP, and user maps carry `noindex`.
- **Join codes** (`join_codes` table): case-insensitive, with optional max uses and expiry, and an on/off switch. `BlueWave2026` (100 uses, no expiry) is seeded. Admins manage codes and see every map at `/admin`.
- **Invites:** on `/profile`, *Show an invite QR code* creates a link that works for 30 minutes (any number of people). Someone already on their own empty map moves over (the empty map is removed); someone whose own map has entries is asked to clear it first.
- **Free tier:** 100 photos per map, each stored at no more than 1.5 MB (re-encoded to fit; at 2000px that rarely changes anything). Uploads and album syncs past the limit are skipped with a note. A map with an admin member has no limits.
- **Profile:** name, map title (script and big lines), tagline, footer, address, members (remove), connected sign-ins, and account deletion. Deleting the last member deletes the map and its photos.

## Moderation

`lib/moderation.js`. Admins (Patrick and Susan) are never checked.

- **Text:** display names (at sign-up and on the profile) and, on the profile, the map's address, titles, tagline, and footer are scored by [Jev](https://typesafe.ai) (`jev-latest`, one yes/no question per changed field, each judged on its own). A score of 0.6 or more refuses the save with "That … isn’t allowed here." Real place names like Dead Horse Point or Devils Tower pass; hate, slurs, sexual, and drug references don't. Random addresses come from curated word lists and aren't checked.
- **Photos:** every upload (and every photo a classic iCloud album sync imports) is checked with Cloud Vision **SafeSearch** using its 640px thumbnail. `adult` or `violence` rated `LIKELY` or `VERY_LIKELY` refuses the photo: it's deleted and the uploader is told. (`racy` alone isn't refused, so beach photos are fine.)
- **Strikes:** refused photos are logged per person in `moderation_events`. More than 10 blocks the account: its sessions end, sign-in shows "Account blocked", and partners on the same map are unaffected. `/admin` lists blocked accounts (with **Unblock**, which also clears their photo strikes) and recent flags.
- **Failures:** if Jev or Vision is unreachable, content is allowed and the error is logged, so an outage doesn't stop uploads.
- **Keys:** the Vision key belongs to the Google Cloud project `datesin50states` (same one as Google sign-in). It's restricted to the Cloud Vision API and to the server's IP (138.197.22.230), so it only works from the server. SafeSearch's first 1,000 images a month are free, then about $1.50 per 1,000.

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

**The map tour.** A faint ▶ in the map's bottom-right corner replays the trip in date order (oldest first) and loops. The map starts blank except for the first stop, and each state appears as the timeline reaches it: the current state is bright and outlined, earlier ones are faded. The map doesn't zoom unless you click it (or pinch out on a phone), which follows each stop zoomed in; click again (or pinch in) for the whole map. The ‹ date › control steps back and forth, clicking the date pauses or resumes, and × (or Esc) ends the tour.

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
