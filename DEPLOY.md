# Deploying Sakshi with Docker

Sakshi runs as six containers on one machine:

| Service | What it does | Port |
|---|---|---|
| `web` | Web app + gateway (sign-in, send, inbox, forensics, ledger pages) | 3000 (published) |
| `v1`–`v4` | Validator nodes of the permissioned ledger (quorum 3 of 4) | 7101–7104 (internal only) |
| `wm` | Watermark engine (embed and trace) | 7200 (internal only, no internet route) |

All keys, the ledger and the encrypted document store live in one folder on the host, `docker-data/`. Keep it safe: it contains the private keys of the validators and the gateway.

---

## 1. Run it on your own computer (Windows, macOS or Linux)

Requirements: Docker Desktop (or Docker Engine with the Compose plugin), about 4 GB free RAM and 5 GB disk.

```bash
cd SIH-Sakshi

# 1. Build the three images (first time takes a few minutes)
docker compose build

# 2. Create the network once: genesis block, validator keys, gateway keys, registrar key
docker compose run --rm setup

# 3. Start everything in the background
docker compose up -d

# 4. Check that all six services are running
docker compose ps
```

Open **http://localhost:3000**.

### First sign-in (the registrar)

Step 2 printed a **registrar passphrase** and wrote two files:

- `docker-data/bootstrap/registrar.sakshikey` (the registrar's key file)
- `docker-data/bootstrap/registrar.pass` (the same passphrase)

1. Go to **Sign in** → **Import a .sakshikey file** → choose `registrar.sakshikey`.
2. Enter the passphrase → you land on **Registry**.
3. Move both files somewhere safe and delete `docker-data/bootstrap/`.

### Adding people

1. Each person opens **Enrol**, picks their roles (recipient, sender, investigator) and a passphrase. Their browser generates their keys and downloads `<their-id>.sakshikey`.
2. The registrar approves them under **Registry** → **Sign certificate**.
3. They sign in with their key file and passphrase.

### Everyday commands

```bash
docker compose ps                 # status
docker compose logs -f web        # follow the web app's log (or v1, v2, wm…)
docker compose restart v3         # restart one service
docker compose stop               # stop everything (data is kept)
docker compose up -d              # start again
docker compose down               # stop and remove containers (data in docker-data/ is kept)
```

### Start over with a brand-new network

```bash
docker compose down
# delete the docker-data folder (this destroys all keys, documents and the ledger)
docker compose run --rm setup
docker compose up -d
```

### Try the fault tolerance yourself

```bash
docker compose stop v4      # 3 of 4 validators: everything still works
docker compose stop v3      # 2 of 4: opening documents is refused (fails safe)
docker compose start v3 v4  # quorum returns, nodes catch up automatically
```

---

## 2. Run it on a cloud server (public demo link)

Use one small Linux server: **2 vCPU, 4 GB RAM, 20 GB disk**, Ubuntu 22.04 or 24.04. Any provider works (AWS EC2, Azure, Google Cloud, DigitalOcean, a college server…).

> The problem statement asks for an **air-gapped** system. A cloud server is only for letting judges try it. For the real deployment see section 3.

### 2.1 Prepare the server

```bash
# On the server, as a user with sudo:
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER        # then log out and back in

# Firewall: allow only SSH, HTTP and HTTPS
sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```

### 2.2 Copy the project to the server

Either `git clone` your repository, or copy the folder from your PC (without `node_modules`, `.next`, `data`, `docker-data` and `demo`):

```bash
scp -r SIH-Sakshi user@SERVER_IP:~/
```

### 2.3 Create the network and start it

```bash
cd ~/SIH-Sakshi
mkdir -p docker-data && sudo chown 1000:1000 docker-data   # containers run as user 1000
docker compose build
docker compose run --rm setup
```

**Option A, quick test over plain HTTP** (fine for a short private test):

```bash
docker compose up -d
# open http://SERVER_IP:3000  (also allow port 3000 in the firewall for this)
```

**Option B, proper HTTPS with your own domain** (recommended for anything public):

1. Point a domain or subdomain (for example `sakshi.yourteam.in`) at the server's IP with a DNS **A record**.
2. Start with the HTTPS override. Caddy obtains a free certificate automatically:

```bash
SAKSHI_DOMAIN=sakshi.yourteam.in docker compose -f docker-compose.yml -f docker-compose.https.yml up -d
```

3. Open **https://sakshi.yourteam.in**. Port 3000 is no longer exposed; only 80/443 are.

Then do the registrar sign-in from section 1. Download `docker-data/bootstrap/registrar.sakshikey` with `scp` first, then delete the bootstrap folder on the server.

### 2.4 Updating to a new version

```bash
cd ~/SIH-Sakshi
git pull                      # or copy the new files
docker compose build
docker compose up -d          # (add the -f … https.yml files again if you use HTTPS)
```

Your data in `docker-data/` stays as it is.

### 2.5 Backups

`docker-data/` is the whole system state. Back it up while the stack is stopped, and **encrypt the backup**, because it contains private keys:

```bash
docker compose stop
tar czf - docker-data | gpg -c > sakshi-backup-$(date +%F).tar.gz.gpg
docker compose start
```

---

## 3. The real deployment: air-gapped

On a connected build machine:

```bash
sh deploy/package-offline.sh          # builds images and writes sakshi-offline.tar
```

Carry `sakshi-offline.tar` (and its `.sha256`) to the offline network, then:

```bash
tar xf sakshi-offline.tar && cd sakshi-offline
docker load -i images.tar
mkdir -p docker-data && sudo chown 1000:1000 docker-data
docker compose run --rm setup && docker compose up -d
```

For validators on **separate machines** (one per organisation), run the setup ceremony once on an offline machine with the real addresses:

```bash
npm run setup -- --hosts 10.0.0.11,10.0.0.12,10.0.0.13,10.0.0.14 --force
```

Give each organisation only its own `nodes/<id>/` folder, its `secrets/<id>.pass` and the public `genesis.json`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Gateway not ready: network not initialised` banner | Run `docker compose run --rm setup` before `up` |
| Opening a document says "only 2/3 validators released their key share" | A validator is down: `docker compose ps`, then `docker compose start v1 v2 v3 v4` |
| "watermark engine is offline" | `docker compose logs wm`; on Linux check `docker-data` is owned by uid 1000 |
| "permission denied" writing `/data` on Linux | `sudo chown -R 1000:1000 docker-data` |
| Port 3000 already in use | Stop the other program, or change `"3000:3000"` to e.g. `"8080:3000"` in `docker-compose.yml` |
| Sign-in loop on HTTPS | Make sure you started with `docker-compose.https.yml` (it sets secure cookies) |
| Validators reject blocks after the machine slept | Clocks drifted; restart the stack (`docker compose restart`) and keep NTP running on the host |
