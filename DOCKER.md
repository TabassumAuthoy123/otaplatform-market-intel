# Setup Guide — Windows + Docker Desktop + VS Code

Running this **alongside** the existing OTAPlatform stack. Nothing here touches
OTAPlatform. No port collisions.

| Stack | Ports on the Windows host |
|---|---|
| OTAPlatform (already running) | `8080` nginx · `8081` phpMyAdmin · `3307` MySQL · `6379` Redis |
| Market Intelligence (this app) | `3000` |

MySQL is published on **3307** on the host (`3307:3306` in OTAPlatform's compose file).
Inside Docker it is still `3306`. Root password is `root`, and there is also
`otauser` / `otapass`.

---

## 0. First — why `npm install` failed

```
C:\Users\SBD-Commercial-06>npm install
npm error Could not read package.json
```

npm was run from your **user home folder**, not from the project folder. There is no
`package.json` there. npm always reads `package.json` from whatever folder you are
standing in.

### Fix

**1. Extract the zip properly.** Right-click `otaplatform-market-intel.zip` →
*Extract All…* → put it next to your OTAPlatform project, for example:

```
D:\projects\OTAPlatform\                  <- existing Laravel project
D:\projects\otaplatform-market-intel\     <- this app
```

**2. `cd` into it, then install.**

```cmd
cd /d D:\projects\otaplatform-market-intel
dir package.json
```

`dir` must print the file. If it says *File Not Found*, you are in the wrong folder —
check whether the extractor made a nested folder
(`otaplatform-market-intel\otaplatform-market-intel\`) and `cd` one level deeper.

```cmd
npm install
npm run dev
```

Open **http://localhost:3000**

> Shortcut: in File Explorer, open the project folder, click the address bar, type
> `cmd`, press Enter. The prompt opens already in the right folder.

That is Option A and it is all you need for the CEO demo. Docker is optional.

---

## Option A — npm dev + OTAPlatform in Docker (recommended)

This is the fastest and what you should use day to day.

```cmd
cd /d D:\projects\otaplatform-market-intel
npm run dev
```

OTAPlatform keeps running in Docker on `8080`. This runs natively on `3000`. Both up at
the same time, zero configuration, instant hot reload.

- OTAPlatform → http://localhost:8080
- phpMyAdmin → http://localhost:8081
- Market Intel → http://localhost:3000

Requires Node.js 18.17+ (`node -v` to check). If Node is missing, install the LTS from
nodejs.org, then reopen the terminal.

---

## Option B — put this app in Docker too, as its own container

Use this when you want it running permanently, or to show it from another machine on the
office network.

```cmd
cd /d D:\projects\otaplatform-market-intel
docker compose up -d --build
```

First build takes 2–4 minutes. After that it starts in seconds.

Docker Desktop → **Containers** → you will now see two entries:

```
otaplatform          (your existing stack)
otaplatform-market-intel
  └─ ota_market_intel   ...   0.0.0.0:3000->3000/tcp
```

Open **http://localhost:3000**

```cmd
docker compose logs -f market_intel    :: watch logs
docker compose restart market_intel    :: restart
docker compose down                    :: stop and remove
docker compose up -d --build           :: rebuild after code changes
```

### Docker with hot reload (edit code, browser refreshes)

```cmd
docker compose -f docker-compose.dev.yml up --build
```

Bind-mounts your source into the container. Ctrl+C to stop. Polling is switched on
because Windows file-change events do not cross the Docker boundary reliably.

---

## Option C — one service inside OTAPlatform's own compose file

Only do this if you genuinely want a single `docker compose up` to start everything.
It couples the two projects together, which is usually not what you want.

Open OTAPlatform's `docker-compose.yml` and add this under `services:`, matching the
existing indentation exactly:

```yaml
  market_intel:
    build:
      # relative to the OTAPlatform folder. On this machine the project sits one
      # level deeper because the zip extracted into a nested folder.
      context: ../otaplatform-market-intel/otaplatform-market-intel
      dockerfile: Dockerfile
    container_name: ota_market_intel
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
```

Fix `context:` to the real relative path from OTAPlatform's folder to this one. Then:

```cmd
cd /d D:\projects\OTAPlatform
docker compose up -d --build market_intel
```

Both apps now appear under the same `otaplatform` group in Docker Desktop, and they share
a network automatically — so `otaplatform_mysql` is reachable by name with no extra work.

---

## Connecting to OTAPlatform's MySQL

Not needed for the demo — the dataset is typed TypeScript and works with no database. Do
this when you want the records editable.

### 1. Find the real network name

```cmd
docker network ls
```

On this machine it prints **`otaplatform_otaplatform`** — OTAPlatform's compose file
declares a network named `otaplatform`, and Docker prefixes the project name. It is
already filled in for you in `docker-compose.yml`; re-check only if you rename the
OTAPlatform folder.

### 2. Enable the shared network

In `docker-compose.yml`, uncomment the `networks:` block on the service **and** the
top-level `networks:` block at the bottom. `name:` is already set to
`otaplatform_otaplatform`.

### 3. Create the database and tables

Run from the **OTAPlatform** folder — that is where the `mysql` service lives:

```cmd
docker compose exec -T mysql mysql -uroot -proot < "D:\authoy dev\otaplatform-market-intel\otaplatform-market-intel\db\schema.sql"
```

It creates the `ota_market_intel` database, all tables, and three reporting views —
a **separate** database inside the same MySQL server, so the `otaplatform` database is
untouched. Confirm in phpMyAdmin at http://localhost:8081.

### 4. Point the app at it

Uncomment `DATABASE_URL` in `docker-compose.yml`:

```
mysql://root:root@otaplatform_mysql:3306/ota_market_intel
```

Container-to-container uses the **service/container name and internal port 3306** — not
`localhost`, and not 3307. If you are running via `npm run dev` on Windows instead of in
Docker, use `127.0.0.1:3307` in a local `.env` file, because from the host it is the
published port.

### 5. Generate the Prisma client

```cmd
npx prisma generate
npx prisma studio      :: GUI to browse and edit records
```

---

## VS Code — both projects in one window

A workspace file ships with the project.

1. Open `otaplatform-workspace.code-workspace` in a text editor.
2. Fix the OTAPlatform path (`"path": "../OTAPlatform"`) to match your machine.
3. VS Code → **File → Open Workspace from File…** → pick that file.

You get both folders in one sidebar. Recommended extensions are listed in the file and
VS Code will prompt to install them: Tailwind CSS IntelliSense, ESLint, Prisma, Docker.

### Two terminals in VS Code

`Ctrl+Shift+` ` opens a terminal. Click the split icon for a second one.

| Terminal | Folder | Command |
|---|---|---|
| 1 | `OTAPlatform` | `docker compose up -d` |
| 2 | `otaplatform-market-intel` | `npm run dev` |

Use the dropdown at the top of the terminal panel to pick which folder each one opens in.

### Claude Code

Run it from whichever project you are working on — it takes the folder you launch it in
as its root:

```cmd
cd /d D:\projects\otaplatform-market-intel
claude
```

Point it at `data/schema.ts` first. That file is the canonical schema; `prisma/schema.prisma`
and `db/schema.sql` are mirrors of it. Change the TypeScript first, then mirror.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Could not read package.json` | Wrong folder | `cd` into the project, `dir package.json` to confirm |
| `npm run dev` says *Missing script: dev* | Wrong folder, or a nested extract | Check `dir` output; `cd` one level deeper |
| `port 3000 is already allocated` | Something else on 3000 | `docker compose down`, or change to `"3001:3000"` in the compose file |
| `EADDRINUSE :3000` with npm | Old dev server still alive | `npx kill-port 3000`, or close the other terminal |
| Docker build fails on `npm ci` | `package-lock.json` missing from the extract | Re-extract the zip; the lockfile must be present |
| Page loads but styling is broken | Stale `.next` cache | Delete the `.next` folder, run `npm run dev` again |
| `unknown flag: --build` | Old Docker Compose v1 | Use `docker-compose up -d --build` (with the hyphen) or update Docker Desktop |
| Edits not showing in Docker | Prod image is a snapshot | Use `docker-compose.dev.yml`, or rebuild with `--build` |
| `ECONNREFUSED 127.0.0.1:3306` from inside a container | Used `localhost` instead of the service name | Use `otaplatform_mysql:3306` container-to-container |
| `ECONNREFUSED 127.0.0.1:3306` from `npm run dev` | MySQL is published on 3307, not 3306 | Use `127.0.0.1:3307` in `.env` |
| `Access denied for user 'root'` | Password is `root`, not `root123` | Check OTAPlatform's `docker-compose.yml` |

---

## Health check

```cmd
curl http://localhost:3000/api/agencies?stats=1
```

Expected:

```json
{"stats":{"total":114,"targets":104,"caabHeld":114,"iataHeld":10,"priorityA":42, ... }}
```

If that returns JSON, the app is healthy and the CEO demo is ready.
