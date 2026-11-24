# Deploying Tafiki on InterServer

Log in at my.interserver.net and check which product you have under **Services**:

- **VPS** (Linux, root access): follow **Option A**. Recommended. It gives full control, background jobs and the best performance.
- **Web Hosting / cPanel**: follow **Option B**. Works if your plan includes "Setup Node.js App" in cPanel.

In both cases the code comes from your GitHub repository, so no one needs to share server passwords.

---

## Option A: InterServer VPS (Ubuntu 22.04 or 24.04)

Connect from your computer: `ssh root@YOUR_SERVER_IP` (the IP and root password are in the InterServer panel). Then run these blocks in order.

### 1. Update and secure the server
```bash
apt update && apt -y upgrade
adduser tafiki && usermod -aG sudo tafiki
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

### 2. Install Node.js 20, MariaDB, Nginx and Git
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt -y install nodejs mariadb-server nginx git
npm install -g pm2
mysql_secure_installation          # set a root password, answer Y to the rest
```

### 3. Create the database
```bash
mysql -u root -p
```
```sql
CREATE DATABASE tafiki CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'tafiki'@'localhost' IDENTIFIED BY 'A-LONG-RANDOM-PASSWORD';
GRANT ALL PRIVILEGES ON tafiki.* TO 'tafiki'@'localhost';
FLUSH PRIVILEGES; EXIT;
```

### 4. Get the code and configure it
```bash
su - tafiki
git clone https://github.com/YOUR-ACCOUNT/tafiki-platform.git
cd tafiki-platform/api      # the API folder in the repository
npm ci --omit=dev
cp .env.example .env && nano .env
```
In `.env` set at least: `DB_PASSWORD`, `JWT_SECRET`, `PAYSTACK_SECRET_KEY`, `TERMII_API_KEY`, `TERMII_SENDER_ID`, `SMILE_PARTNER_ID` and `SMILE_API_KEY` (make one with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`), `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD`, and your SMTP details when you have an email provider.

### 5. Create tables, the first Super Admin, and start
```bash
npm run migrate
npm run create-admin
pm2 start src/server.js --name tafiki-api
pm2 save && pm2 startup     # follow the command it prints so it restarts after reboots
curl http://localhost:4000/api/health
```

### 6. Website and API through Nginx
Create `/etc/nginx/sites-available/tafiki` (as root):
```nginx
server {
  server_name tafiki.com www.tafiki.com;
  root /home/tafiki/tafiki-platform/web;   # folder with index.html and img/
  index index.html;
  location / { try_files $uri $uri/ /index.html; }
}
server {
  server_name api.tafiki.com;
  location / { proxy_pass http://127.0.0.1:4000; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Forwarded-Proto $scheme; }
}
```
```bash
ln -s /etc/nginx/sites-available/tafiki /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

### 6b. Switch the website to live mode
The website ships in **demo mode** (sample data in the browser, nothing saved). To connect it to the real API, edit one line near the top of `web/index.html`:
```html
<meta name="tafiki-api" content="https://api.tafiki.com">
```
With that set, the site:
- signs members in with email and password against the API (no demo accounts, no prototype bar);
- creates real accounts and opens Smile ID for identity checks;
- takes card and bank-debit payments through Paystack, and records bank transfers for Finance to confirm;
- runs the mart portal and the console (`https://tafiki.com/control`) from live data, with each admin limited by their role.

Leave the value empty to go back to demo mode. Do this after step 7, so the API already has its SSL certificate.

### 7. Domain and free SSL
At your domain registrar, add **A records** for `tafiki.com`, `www` and `api` pointing to the VPS IP. When they resolve:
```bash
apt -y install certbot python3-certbot-nginx
certbot --nginx -d tafiki.com -d www.tafiki.com -d api.tafiki.com
```

### 8. Daily database backup
```bash
crontab -e
# add this line (as the tafiki user):
0 2 * * * mysqldump -u tafiki -p'A-LONG-RANDOM-PASSWORD' tafiki | gzip > ~/backups/tafiki-$(date +\%F).sql.gz
```
(Run `mkdir ~/backups` first, and copy backups off the server regularly.)

### Updating later
```bash
cd ~/tafiki-platform && git pull && cd api && npm ci --omit=dev && npm run migrate && pm2 restart tafiki-api
```

---

## Option B: InterServer cPanel hosting

1. **Database:** cPanel › MySQL Databases. Create database `tafiki`, a user, add the user to the database with All Privileges. Note the full names (cPanel adds a prefix, for example `abc_tafiki`).
2. **Code:** cPanel › Git Version Control › Create. Clone `https://github.com/YOUR-ACCOUNT/tafiki-platform.git` into a folder such as `tafiki-platform`.
3. **Node app:** cPanel › Setup Node.js App › Create Application.
   - Node.js version: 20 or newer
   - Application root: `tafiki-platform/api`
   - Application URL: `api.tafiki.com` (create the subdomain first under cPanel › Domains)
   - Application startup file: `src/server.js`
   - Add the environment variables from `.env.example` (DB_HOST `localhost`, the prefixed database name and user, JWT_SECRET, and so on).
   - Click **Run NPM Install**, then use the "Run JS script" box to run `migrate` and `create-admin`, then **Restart**.
4. **Website:** copy `index.html` and the `img` folder from the repository's `web` folder into `public_html` (File Manager or Git deploy).
5. **SSL:** cPanel › SSL/TLS Status › Run AutoSSL for tafiki.com and api.tafiki.com.
6. **Backups:** cPanel › Backup, or JetBackup if your plan has it.

Note: Termii needs an approved Sender ID (request it in the Termii dashboard; approval can take a few days). Limitation: shared hosting may stop idle Node apps and limits background jobs. Stages 3 and 4 run timed jobs (delivery stages, audit reminders, payouts), so a VPS is recommended before launch.

---

## After deployment

- Visit `https://api.tafiki.com/api/health`: it should show `"ok": true`.
- Sign in to the console with the Super Admin you created, open Settings › Admin Access and add your team.
- Keep `.env` private. Never commit it to GitHub.
