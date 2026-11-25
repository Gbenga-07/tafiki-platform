# Taking Tafiki live with Claude: test mode first, then live

This plan puts tafiki.com on your InterServer VPS in **test mode** first. Everything works end to end, but no real money moves, ID checks use sandbox data, SMS are logged instead of sent, and emails wait in the console. When the test run is clean, you swap in live keys.

You type the commands that need your passwords. **Claude Code**, running on the server, does the rest: installing, configuring, testing and fixing. The repository includes a `CLAUDE.md` file that Claude Code reads automatically. It tells Claude the project layout and the safety rules, such as never printing your keys and never switching to live without your word.

**Time:** about 2 hours for test mode, plus waiting time for DNS and account approvals.

---

## Phase 1: Accounts and test keys (on your laptop or phone, 30–45 min)

You'll paste these keys into the server's settings file yourself in Phase 4. **Don't paste them into any chat**, including Claude.

### 1. Paystack (test mode)
1. Sign up at dashboard.paystack.com. New accounts start in **Test mode**.
2. Go to **Settings → API Keys & Webhooks** and stay in **Test mode**.
3. Copy the **Test Secret Key** (starts `sk_test_`) and **Test Public Key** (starts `pk_test_`).
4. Set the **Test Webhook URL** to `https://api.tafiki.com/webhooks/paystack`.
5. Set the **Test Callback URL** to `https://tafiki.com/#pay-result`.
6. Start your **compliance** submission now (business documents). Live keys only appear after Paystack approves it.

### 2. Smile ID (sandbox)
1. Sign up at portal.usesmileid.com.
2. Under the developer/API keys area, choose **Sandbox**. Copy your **Partner ID** and **Sandbox API key**.
3. Register the callback URL `https://api.tafiki.com/webhooks/smileid`.
4. Open Smile ID's **Test Data** page in their documentation and keep the Nigeria test ID numbers handy. **Real ID numbers do not work in the sandbox.**
5. Start Smile ID's business KYC/contract process now. Production keys come after it.

### 3. Termii (SMS): nothing needed for test mode
- In test mode, leave the Termii key empty. Delivery-code SMS then appear in **Console → Logistics → SMS log** marked "logged". Marts still see their code in their own portal.
- **Start this now anyway:** sign up at termii.com and request the Sender ID **Tafiki** for the **DND (transactional)** route. Approval can take days, and live delivery codes need it.

### 4. Email: nothing needed for test mode
- With no email provider set, every email is kept in **Console → Email Correspondence**, so you can read exactly what members would receive.
- For go-live, pick a provider (for example Zoho ZeptoMail, Resend or Google Workspace) and get its **SMTP** host, port, username and password.

### 5. Claude
- Claude Code needs a paid Claude plan (Pro or Max). You'll sign in from the server in Phase 3.

---

## Phase 2: Point the domain at the server (5 min, then wait)
1. In the InterServer panel, open your VPS and note its **IP address** and **root password**.
2. At your domain registrar's DNS settings, add three **A records** pointing to that IP: `tafiki.com` (shown as `@`), `www`, and `api`.
3. DNS can take from minutes to a few hours. Claude will check it before requesting SSL.

---

## Phase 3: Connect to the server and start Claude Code (15 min)

On your laptop, open **Terminal** (Mac) or **PowerShell** (Windows):

```bash
ssh root@YOUR_SERVER_IP
```
Type the root password from the InterServer panel. Then paste these lines one block at a time:

```bash
# a normal user for the site, with admin rights
adduser tafiki                 # choose a strong password and write it down
usermod -aG sudo tafiki
apt update && apt -y install git curl
su - tafiki
```

Now, as the `tafiki` user, install Claude Code, the GitHub tool, and the code:

```bash
curl -fsSL https://claude.ai/install.sh | bash
exec bash -l                   # reload the shell so the "claude" command is found

sudo apt -y install gh
gh auth login                  # choose GitHub.com → HTTPS → "Login with a web browser", then enter the code it shows
git clone https://github.com/Gbenga-07/tafiki-platform.git
cd tafiki-platform
claude
```

The first time `claude` runs, it shows a sign-in link. Open it on your laptop and approve, then come back to the terminal. When asked whether to trust the folder, choose **Yes**.

Claude will ask before running each command. Read the request and approve. When it needs `sudo`, it will ask you to type the `tafiki` user's password into the terminal.

---

## Phase 4: Let Claude build the server (30–45 min)

### Prompt 1: install everything (paste into Claude Code)
```
Read CLAUDE.md and api/docs/deploy-interserver.md (Option A). Set this Ubuntu VPS up for Tafiki in TEST MODE:
1. Firewall (allow SSH, 80, 443), Node.js 20, MariaDB, Nginx, PM2. Secure MariaDB.
2. Create the database "tafiki" and a database user with a long random password.
3. Install the API dependencies in api/.
4. Create api/.env from .env.example with: NODE_ENV=production, the real database password, a fresh 96-character JWT_SECRET,
   APP_URL=https://tafiki.com, API_URL=https://api.tafiki.com, COOKIE_DOMAIN=.tafiki.com, SMILE_ENV=sandbox, SIMULATION=1.
   Leave PAYSTACK_*, SMILE_PARTNER_ID, SMILE_API_KEY, TERMII_API_KEY and SMTP_* EMPTY, and do not show me the file.
5. Stop and tell me which lines in api/.env I must fill in myself.
```

### You: add the test keys yourself
In a **second** terminal window on your laptop, run `ssh tafiki@YOUR_SERVER_IP`, then:
```bash
nano ~/tafiki-platform/api/.env
```
Fill in:
- `PAYSTACK_SECRET_KEY=sk_test_...` and `PAYSTACK_PUBLIC_KEY=pk_test_...`
- `SMILE_PARTNER_ID=...` and `SMILE_API_KEY=...` (sandbox key)
- `SUPERADMIN_NAME`, `SUPERADMIN_EMAIL`, and a strong `SUPERADMIN_PASSWORD`

Save with **Ctrl+O, Enter**, then exit with **Ctrl+X**.

### Prompt 2: finish and switch the website to live mode
```
I've filled in api/.env. Now:
1. Run the migrations, create the Super Admin, start the API with PM2 and make it start on boot.
2. Configure Nginx for tafiki.com/www (root = web/) and api.tafiki.com (proxy to port 4000).
3. Check DNS for tafiki.com, www and api points here, then get SSL with Certbot for all three.
4. In web/index.html set <meta name="tafiki-api" content="https://api.tafiki.com"> (live mode).
5. Set up the nightly database backup from the deploy guide.
6. Run npm run check in api/ and npm test, and show me the results (no secrets).
```
Expected `npm run check` result: Paystack "Test key… accepted", Smile ID "sandbox… issued a web token", SMS "logged", email "kept in the console". `npm test`: 0 failures.

---

## Phase 5: The simulation run (on your phone and laptop, about 1 hour)

Open **https://tafiki.com**. A small **"Test mode"** label should show at the bottom of the screen. It stays until every service is live.

| # | Do this | You should see |
|---|---|---|
| 1 | Go to **tafiki.com/console** and sign in with your Super Admin email and password | The console dashboard |
| 2 | Use **Get started** to register a mart account: "FOODCORE Test", with your second email and phone | Mart portal shows "Your mart is being reviewed" |
| 3 | In the console, open **Investment Packages → Add package**: name "FOODCORE Test", **2 units** | A funding package, 0 of 2 |
| 4 | In a private browser window, register as a unit holder with your own email | The Smile ID screen opens |
| 5 | Complete Smile ID with a **sandbox test ID number** and a selfie | Shortly after, Console → Investors shows **Verified**. If it shows "review", approve it in the console |
| 6 | Buy **1 unit by card**. On the Paystack page use **4084 0840 8408 4081**, CVV **408**, any future expiry | Paystack shows **₦2,050,000** (₦2,000,000 unit + ₦50,000 yearly membership fee, first stake only). Back on Tafiki: unit confirmed, certificate shown, membership "paid until" a year ahead. The email is in Console → Email Correspondence |
| 7 | Try a failed payment: start another purchase and use **4084 0800 0000 5408**, CVV **001** | Payment declined. The unit stays reserved for 48 hours |
| 8 | Buy the 2nd unit by **bank transfer** and tap "I've made the transfer" | No membership fee this time (₦2,000,000 only). Console → Units and Payments shows it waiting. Click **Funds Received** |
| 9 | Package is now full. Click **Open package** | One delivery per stake appears in **Deliveries** |
| 10 | Move a delivery to **In Transit** (or wait 6 hours per stage) | Console → SMS log shows the code message as "logged". The mart portal shows the 6-digit code |
| 11 | Click **Complete** and enter the code | Delivered. Mart shelf value goes up |
| 12 | Ask Claude: `Run npm run sim:advance -- 28 in api/` | The platform jumps 28 days ahead |
| 13 | Mart portal: **Submit Sales** (for example ₦1,000,000). Console → Audit: record the audit | Remittance Due appears in the mart portal |
| 14 | Mart portal: **Remit**. Console → Remittance: **Confirm**. Console → Audit: **Reconcile** | The cycle closes, and a restock replaces exactly what sold |
| 15 | Ask Claude: `Run npm run sim:advance -- 65 in api/` | 90+ days have passed |
| 16 | Console → **Payouts** → the package → **Run payout** with a profit figure | Unit holders' wallets are credited |
| 17 | As the unit holder: **Wallet → Withdraw** ₦50,000 | Request shows "processing" |
| 18 | Console → **Withdrawals** → mark paid with a reference | The holder's wallet history shows it paid |
| 19 | Console → **Admin access**: add a **Logistics Officer**. Sign in as them | Payment and payout buttons are greyed out with "Ask a Super Admin" |
| 20 | Repeat steps 4–6 on your **phone** | Everything fits the screen and works |

If anything looks wrong, describe it to Claude in plain words. For example: `On the mart portal the remittance button does nothing after I tap it. Investigate using pm2 logs and fix it, then run the tests.`

---

## Phase 6: Go live (after Paystack, Smile ID and Termii approve you)

### 1. Prove a real payment works, before wiping the test data
Tell Claude:
```
I'm about to put live Paystack keys in api/.env. After I do, restart the API and run npm run check.
```
Then, in **Paystack → Settings → API Keys & Webhooks (Live)**:
1. Copy the live keys into `api/.env` with `nano` yourself.
2. Set the **Live** Webhook URL to `https://api.tafiki.com/webhooks/paystack` and the Live Callback URL to `https://tafiki.com/#pay-result`.
3. In the console, set **Terms & Settings → Unit Price** to **10,000** for a moment. That's the lowest the system allows.
4. Buy 1 unit in a test package with your own card.
5. Confirm it arrived in Paystack, then **refund it** from the Paystack dashboard.
6. You don't need to change the price back: the wipe in step 3 below resets every setting to the defaults (₦2,000,000 per unit).

### 2. Live identity, SMS and email
Edit `api/.env` yourself:
- `SMILE_API_KEY` = production key, `SMILE_ENV=production`
- `TERMII_API_KEY` = your key, `TERMII_SENDER_ID=Tafiki` (once approved)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` from your email provider
- Delete the `SIMULATION=1` line

### 3. Wipe the test data and start clean (prompt for Claude)
```
We are going live. 1) Back up the database to ~/backups/before-launch.sql.gz. 2) Drop and recreate the tafiki database,
run the migrations and create the Super Admin again from .env. 3) Restart the API. 4) Run npm run check and confirm
Paystack is LIVE, Smile ID is production, SMS is live, email is live and SIMULATION is off. Ask me before dropping anything.
```
The "Test mode" label disappears once every service is live.

### 4. Final checks
- Send one SMS to your own phone: create a small mart order to your test mart and move it to In Transit, then cancel or complete it.
- Register yourself as the first real member with your real NIN.
- Have counsel confirm the Terms and Conditions (currently marked "proposed").
- Add your team in **Console → Admin access** with the right roles. Only you should be Super Admin.

---

## After launch: everyday prompts for Claude
- **Updates:** `Pull the latest code from GitHub, install, migrate, run the tests, and restart the API if they pass.`
- **Health:** `Check pm2 status, the last 200 lines of the API logs, disk space and last night's backup. Tell me anything wrong.`
- **Backup check:** `Restore last night's backup into a temporary database, count members and holdings, then delete the temporary database.`
- **Something broke:** describe what you saw, on which page, and at what time.

## If you're stuck
- **"claude: command not found":** run `exec bash -l` or log out and back in.
- **SSL fails:** DNS isn't pointing at the server yet. Wait, then ask Claude to retry Certbot.
- **Paystack payment doesn't confirm:** check the webhook URL matches the mode of the key (test vs live).
- **Smile ID never finishes:** check the callback URL in the Smile portal, and use sandbox test IDs while `SMILE_ENV=sandbox`.
- **Locked out of the console:** on the server, run `npm run create-admin -- "Your Name" you@email.com NewPassword123` in `api/`.
