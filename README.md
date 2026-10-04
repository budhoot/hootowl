# HootOwl Lead Rescue – backend

Missed-call text-back for HootOwl clients, built with **Node.js + Express**, **Twilio** and **PostgreSQL**.

1. A caller rings a client's **Twilio number**. Twilio asks this API what to do, and the API says
   "forward the call to the business phone".
2. If the business doesn't pick up (**busy**, **no-answer** or **failed**), the API saves a missed
   call and puts it on the **recovery queue** in PostgreSQL. Answered calls get no text.
3. The **recovery worker** (a second, separate program) takes queued missed calls and texts the
   caller, e.g. *"Hi, this is Acme Plumbing. Sorry we missed your call! … Book online: … Reply STOP to opt out."*
   It skips the text when:
   - the client is inactive or recovery is disabled
   - the caller texted **STOP**
   - the caller already got a recovery text from that client in the last **24 hours**
   - the caller ID was hidden
4. Caller replies and delivery reports come back from Twilio and are saved.
5. The HootOwl operator reads the **lead inbox** and manages clients through the **admin API**,
   using a secret `ADMIN_API_KEY`.

If Twilio's answer to a send is unclear (timeout, network drop, worker crash), the text is marked
`needs_review` and is **never resent automatically**, so nobody gets a duplicate. An operator checks
the Twilio console and resolves it.

All four Twilio webhooks verify Twilio's signature, so nobody else can fake calls or texts.

---

## 1. Install the tools (one time)

You need these on your Windows computer. Install each one, keeping the default options:

| Tool | What it's for | Where to get it |
| --- | --- | --- |
| **Node.js 22 LTS** (or newer) | Runs the JavaScript code. Includes `npm`, which installs libraries. | https://nodejs.org |
| **Git** | Downloads and uploads code to GitHub. | https://git-scm.com/download/win |
| **PostgreSQL 16+** with **pgAdmin** | The database. The installer includes pgAdmin. **Write down the `postgres` password you choose.** | https://www.postgresql.org/download/windows/ |
| **ngrok** | Gives your computer a temporary public https address, so Twilio can reach it while you test. | https://ngrok.com/download |

Check that the tools installed. Open **PowerShell** (press the Windows key, type `PowerShell`,
press Enter) and type each line, pressing Enter after each:

```powershell
node --version
npm --version
git --version
```

Each should print a version number. If you see *"is not recognized"*, close PowerShell, open it
again, and retry. Newly installed tools are only picked up by new windows.

## 2. Download the code

In PowerShell:

```powershell
cd $HOME\Documents
git clone https://github.com/budhoot/hootowl.git
cd hootowl
npm install
```

- `cd` = "change directory" (move into a folder).
- `git clone` downloads the repository into a new `hootowl` folder.
- `npm install` downloads the libraries listed in `package.json` into `node_modules`.

From now on, run every command **inside the `hootowl` folder**. In PowerShell, the prompt shows
where you are, e.g. `PS C:\Users\you\Documents\hootowl>`.

## 3. Create your passwords and settings

```powershell
npm run setup
```

This creates two private files in the `hootowl` folder:

- **`.env`** holds all settings, with a strong random **database password** and **`ADMIN_API_KEY`**
  already filled in.
- **`database-setup.sql`** holds the commands that create the database user with that password.

Both are listed in `.gitignore`, so Git will never upload them to GitHub.

> **Changing a password later:** open `.env` in Notepad (`notepad .env`), edit the value, save, and
> restart the API and worker. For the **database** password, also run
> `ALTER ROLE hootowl WITH PASSWORD 'new-password';` in pgAdmin (see the note at the bottom of
> `database-setup.sql`), and update **both** `DATABASE_URL` lines in `.env` to match.

## 4. Create the database

1. Open **pgAdmin** and log in with the `postgres` password you chose when installing.
2. In the left panel, expand **Servers → PostgreSQL**, right-click **postgres** (under Databases)
   → **Query Tool**.
3. Back in PowerShell, run `notepad database-setup.sql`, copy everything, paste it into the Query
   Tool, and press **F5** (Execute).
4. You should see `CREATE ROLE` / `CREATE DATABASE` messages. **Delete `database-setup.sql`**
   afterwards, because it contains your password.

Then create the tables:

```powershell
npm run migrate
```

Expected output: `Applied migration 001_initial.sql` then `Database is up to date.`

## 5. Add your Twilio details

1. Log in at https://console.twilio.com. On the dashboard, find **Account SID** and
   **Auth Token** (click "show").
2. `notepad .env` → set `TWILIO_ACCOUNT_SID=` and `TWILIO_AUTH_TOKEN=` → save.

The **Auth Token** is a password too: it lets someone send texts on your account. Keep it only in
`.env`.

## 6. Run it: desktop shortcut (easiest)

Create a **HootOwl Dashboard** shortcut, with the owl icon, on your desktop. Run this once:

```powershell
npm run shortcut
```

From now on, **double-click the HootOwl Dashboard icon** on your desktop. It:

1. starts the API and the recovery worker if they aren't already running. They appear as minimized
   windows called **HootOwl API** and **HootOwl Worker** on your taskbar.
2. opens the dashboard in your web browser.

To stop HootOwl, close those two taskbar windows. If you move the `hootowl` folder, run
`npm run shortcut` again.

**Automatic updates.** Every time you double-click the shortcut, it checks GitHub for changes
merged into `main` and downloads them, so you never need to type `git pull` yourself:

- **HootOwl not running:** it updates first, installs any new libraries, then starts.
- **HootOwl already running:** if there's an update, it asks *"Restart HootOwl now to install
  it?"* Choose **No** at a busy time. Calls to your clients' numbers don't connect during the
  ~30-second restart, and you'll be asked again next time.
- **No internet:** it quietly starts the version you already have.
- **You edited HootOwl's files yourself:** it skips the update and tells you which files, so your
  edits are never overwritten.

Database changes are applied automatically when the new version starts. To turn updates off, add
`HOOTOWL_AUTO_UPDATE=false` to `.env`.

**ngrok (so Twilio can reach your computer).** ngrok gives every free account one **fixed domain**.
Find it in the ngrok dashboard under **Domains**, e.g. `owl-example.ngrok-free.app`. In `.env` set:

```
NGROK_DOMAIN=owl-example.ngrok-free.app
PUBLIC_BASE_URL=https://owl-example.ngrok-free.app
```

The shortcut then starts ngrok too (as a **HootOwl ngrok** window), and the address never changes,
so you only set it in Twilio once. The first time you use ngrok, connect it to your account:
`ngrok config add-authtoken <your token from the ngrok dashboard>`.

### Running by hand instead

You can also run each part in its own PowerShell window (each `cd`'d into `hootowl`):

```powershell
ngrok http --url=owl-example.ngrok-free.app 3000   # window 1: public address for Twilio
npm start                                          # window 2: the API + dashboard
npm run worker                                     # window 3: sends the recovery texts
```

Then open **http://localhost:3000/dashboard/** in your browser. To stop one, click its window and
press **Ctrl + C**.

## 7. Point your Twilio number at the API

In the Twilio console: **Phone Numbers → Manage → Active numbers →** click the number.

- **Voice Configuration → A call comes in →** Webhook, `https://YOUR-ADDRESS/webhooks/twilio/voice`, HTTP **POST**
- **Messaging Configuration → A message comes in →** Webhook, `https://YOUR-ADDRESS/webhooks/twilio/sms`, HTTP **POST**

Save. You don't need to set the other two webhooks (`dial-result`, `sms-status`) anywhere,
because the API gives Twilio those addresses itself.

> US numbers: sending texts to US phones from a 10-digit number requires **A2P 10DLC
> registration** in the Twilio console (Messaging → Regulatory Compliance). Unregistered texts are
> blocked by carriers.

## 8. Use the dashboard

Sign in with the `ADMIN_API_KEY` from your `.env` file (`notepad .env`, copy the value after `=`).
Tick **Remember on this computer** to stay signed in. Only do that on your own computer.

| Page | What you do there |
| --- | --- |
| **Overview** | Missed calls, texts sent, replies, answer rate, and anything needing attention. A banner warns you if the worker is offline. |
| **Lead inbox** | Every missed call: the text we sent, whether it was delivered, and the caller's replies. Click a phone number to call back. |
| **Clients** | Add businesses, turn recovery texts on/off, and open **Manage** to change the business phone, booking link, custom text (with a live preview) and Twilio numbers. |
| **Needs attention** | Texts whose outcome is unknown or that Twilio refused. Check the Twilio console, then choose **It was sent**, **Don't send**, or **Send it / Try again**. |

The **All clients** menu at the top filters every page to one business. The **Texting on / offline**
light shows whether the recovery worker is running.

**Add your first client:** go to **Clients → Add client**, then enter the business name, the Twilio
number callers will dial, and the business's real phone. You can type phone numbers any way you
like, e.g. `(512) 555-0100`. Then call the Twilio number from your mobile and **don't answer**
the business phone. Within a few seconds you should get the recovery text, and the call appears
in the **Lead inbox**.

### Doing the same from PowerShell (optional)

Everything in the dashboard is also available from the admin API. `$key` must be your
`ADMIN_API_KEY` from `.env`:

```powershell
$key = (Select-String -Path .env -Pattern '^ADMIN_API_KEY=(.*)$').Matches[0].Groups[1].Value
$headers = @{ Authorization = "Bearer $key" }

$body = @{
  name        = "Acme Plumbing"
  booking_url = "https://hootowl.net/book/acme"
  routes      = @(@{ twilio_number = "+15551230000"; forward_to_number = "+15559870000" })
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri http://localhost:3000/admin/clients -Headers $headers -ContentType "application/json" -Body $body
Invoke-RestMethod -Uri http://localhost:3000/admin/inbox -Headers $headers | ConvertTo-Json -Depth 6
```

The API expects phone numbers in **E.164** format: `+`, country code, number, no spaces (`+15551230000`).

### Admin API reference

Every request needs the header `Authorization: Bearer <ADMIN_API_KEY>`. Bodies are JSON.

| Method & path | What it does |
| --- | --- |
| `GET /admin/clients` | List clients with their phone routes |
| `POST /admin/clients` | Create a client. Body: `name` (required), `booking_url`, `recovery_message`, `active`, `recovery_enabled`, `routes: [{twilio_number, forward_to_number}]` |
| `GET /admin/clients/:id` | One client |
| `PATCH /admin/clients/:id` | Change any of `name`, `booking_url`, `recovery_message`, `active`, `recovery_enabled` |
| `POST /admin/clients/:id/recovery/enable` | Turn recovery texts on |
| `POST /admin/clients/:id/recovery/disable` | Turn recovery texts off (calls still forward) |
| `POST /admin/clients/:id/routes` | Add a Twilio number: `{twilio_number, forward_to_number}` |
| `GET /admin/routes?client_id=` | List phone routes |
| `PATCH /admin/routes/:id` | Change `forward_to_number` or `active` (inactive = "not in service") |
| `GET /admin/inbox?client_id=&limit=&offset=` | **Lead inbox**: missed calls + recovery text status + caller replies |
| `GET /admin/replies?client_id=` | All texts callers sent in |
| `GET /admin/stats?client_id=` | Dashboard numbers (missed calls, texts, replies, items needing attention) and whether the worker is online |
| `GET /admin/recovery?status=needs_review` | Recovery queue, filterable by status |
| `POST /admin/recovery/:id/resolve` | Settle a `needs_review`/`failed` item: `{"status": "sent"}` (it did go out), `"failed"` (it didn't), or `"pending"` (try again) |
| `GET /health` | `{"ok": true, "worker_online": true}` when the API can reach the database (no key needed) |

**Custom text:** set `recovery_message` on a client, e.g.
`"Thanks for calling {business_name}! Book here: {booking_url}"`. "Reply STOP to opt out." is
added automatically if your text doesn't mention STOP.

**Recovery statuses:** `pending` → `sending` → `sent`, or `skipped` (with a `skip_reason`:
`client_inactive`, `recovery_disabled`, `opted_out`, `cooldown`, `caller_number_unavailable`),
`failed` (Twilio refused; nothing sent), `needs_review` (outcome unknown).

## 9. Run the tests

The tests use a separate `hootowl_test` database, which is **wiped on every run**. It was created
in step 4, and `TEST_DATABASE_URL` in `.env` points at it.

```powershell
npm test
```

You should see `# fail 0`. No real calls or texts are made, because the tests use
a fake Twilio.

## Deploying to production

Run the API (`npm start`) and the worker (`npm run worker`) as **two separate services** on any
Node host (Render, Railway, Fly.io, a VPS, …) with a managed PostgreSQL. On the host, set the same
variables as `.env` (the host's dashboard has an "Environment variables" page), with
`PUBLIC_BASE_URL` set to the API's https address, e.g. `https://api.hootowl.net`. Both programs
create and update the database tables automatically when they start. The dashboard is then at
`https://api.hootowl.net/dashboard/`. Point your desktop shortcut there with
`npm run shortcut -- -Url https://api.hootowl.net/dashboard/`. The worker can be offline for
a while: missed calls wait in the queue until it comes back.

## Troubleshooting

| You see | Why / fix |
| --- | --- |
| `Missing required environment variable …` | `.env` is missing that line or it's empty. Run `npm run setup`, or edit `.env`. |
| `password authentication failed for user "hootowl"` | The password in `DATABASE_URL` doesn't match the database. Re-run the `ALTER ROLE` command in pgAdmin with the password from `.env`. |
| `ECONNREFUSED … 5432` | PostgreSQL isn't running. Open **Services** (Windows key → "Services") and start **postgresql-x64-16**. |
| Twilio says *"an application error has occurred"* | Check the API window for errors. In the Twilio console, open **Monitor → Logs → Errors**. |
| Twilio error **11200** / API returns **403** | The signature check failed. Usually `PUBLIC_BASE_URL` doesn't exactly match the address in the Twilio console (http vs https, old ngrok address, trailing `/`), or the Auth Token is wrong. |
| Call forwards, but no text | Is the dashboard light **Texting offline**? Start the worker. Otherwise the call's card in the **Lead inbox** says why it wasn't texted. |
| Double-clicking the shortcut does nothing | Open PowerShell in `hootowl` and run `powershell -ExecutionPolicy Bypass -File scripts\start-hootowl.ps1` to see the error message. |
| Dashboard says *"Cannot reach the HootOwl API"* | The API window was closed. Double-click the shortcut again. |
| `EADDRINUSE :3000` | The API is already running in another window. Close it, or set `PORT=3001` in `.env`. |

## Project layout

```
public/dashboard/        the operator dashboard (HTML, CSS, JavaScript, logo)
assets/hootowl.ico       owl icon for the desktop shortcut
src/
  server.js              starts the API (and serves the dashboard)
  worker.js              starts the recovery worker
  app.js                 Express app: routes + error handling
  config.js              reads and checks settings from .env
  db.js, migrate.js      PostgreSQL connection and table setup
  twilioSignature.js     verifies requests really come from Twilio
  phone.js               phone-number format + STOP/START keywords
  routes/twilio.js       the 4 Twilio webhooks
  routes/admin.js        the admin API
  recovery/worker.js     claim → check → send → save logic
  recovery/message.js    builds the recovery text
  recovery/deliveryStatus.js  applies Twilio delivery updates
  recovery/heartbeat.js  lets the dashboard know the worker is running
migrations/                   database tables
scripts/setup-env.js          creates .env with random passwords
scripts/create-desktop-shortcut.ps1   npm run shortcut
scripts/start-hootowl.ps1     what the desktop shortcut runs
test/                         automated tests (npm test)
```

**Not in this MVP (future work):** AI conversations and creating calendar appointments. Callers can
already book through the client's existing `booking_url` page, which can be hosted on Wix / hootowl.net.
