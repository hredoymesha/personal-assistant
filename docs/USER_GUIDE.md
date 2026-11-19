# Using Personal Assistant

A quick tour of the five tabs. If you just want to look around, tap **Load sample data** on Home. Everything it adds starts with "Sample:" and **Settings > Remove sample data** takes it all out again without touching your own entries.

## Home

Today's tasks, what's due this week, this month's spending and bill totals, and short summaries of savings, debts and wallets.

The **＋ Task** and **＋ Expense** buttons jump straight to a new entry.

The quick command box takes a sentence like "I spent 120 taka on transport yesterday" or "kal 200 taka bazar" and turns it into a draft. Nothing is saved until you check the draft and tap Save. If the sentence leaves something out, such as the currency or which day "kal" means, it asks instead of guessing.

**Emergency SOS** can open your phone's dialer with 999 or share your current location, but only when you tap those buttons. The app never tracks your location in the background, and it can't promise that emergency services receive your location.

## Tasks

Tap **＋ New**, give the task a title and, if you like, notes, a due date, a time, a priority, a category and a repeat. A repeating task moves to its next date when you finish it.

Search finds tasks as you type. Finished tasks can be reopened. Deleted tasks go to Trash.

## Money

**Expenses**: amount, category, date and an optional note. Pick a wallet only if the money came out of it; the wallet's balance goes down by the same amount. You can attach a photo or PDF of the receipt, up to 10 MB each.

**Savings**: create a goal with a target, then add to it as you save.

**Debts**: record who owes whom, how much and in which currency. When you record a payment for someone you have several debts with, it pays off the oldest one first. You can't pay more than is owed. The Reminder button writes a polite message you can send on WhatsApp.

**Wallets**: one wallet per cash pocket, bank account, card or mobile wallet. Each wallet has one currency. Manual entries change its balance, and transfers move money between two wallets of the same currency. Balances can go below zero.

**Mess**: for a shared flat or mess. Create a group, add members, record how many meals each person ate, and add shared costs. A cost can be split by meals, equally, or with custom amounts. The split is fixed once saved, so changing meal counts later doesn't rewrite old costs.

## Cycle

**Bills**: monthly bills such as rent, electricity or internet. Pay all of a bill or part of it; whatever is left carries into next month. **Change this month** sets a different amount or category for one month only. **Add starter categories** gives you a list of common bill groups to start from, which you can rename and reorder.

**Income**: what came in this month.

**History**: every payment made in the month.

**Month**: income against bills, what's paid and what's left. If bills are bigger than income it says so plainly as a shortfall. **Close month** makes that month read-only; you can reopen it, and each close and reopen is kept in the lock history.

**Daily sheet**: a day-by-day list, like a notebook. Each entry has a date, a place, an amount and a note, and you can add your own columns. Dates can be typed with Bengali digits. Filter by date range or search, then export the filtered list as CSV, or as an Excel file plus a PDF. Imports from CSV or Excel show a preview first, and rows you already have are flagged as duplicates.

## Settings

Theme, default currency for new entries, and these sections:

- **Backup & move your data**: encrypted backups, restore, and plain-text exports. See below.
- **Trash**: deleted items stay here for 30 days. Restore them, delete them for good, or empty the Trash.
- **Device contacts** (phone only): reads your contacts only when you tap Refresh contacts.
- **Browser storage** (web only): shows how much space the browser gives the app and can ask it to keep the data.
- **Google Drive Cloud Backup**: optional; see below.
- **Privacy & storage**: what is stored where.

## Backups

**Create encrypted backup** asks for a passphrase of at least 12 characters and saves a file you can keep anywhere. Without the passphrase the file can't be opened, and nobody, including the developer, can reset it. Write it down somewhere safe.

**Verify a backup** checks that a file and its passphrase work without changing anything.

**Restore from file** shows what's in the backup, asks you to type REPLACE, and only then replaces your data. Right after a restore you can undo it.

Plain-text exports (JSON and CSV) are readable by anyone who gets the file. Use them only when you need the raw data.

## Google Drive

Optional. In the web version it can back up straight to your own Google Drive once the app's Google settings are in place (see GOOGLE_DRIVE_SETUP.md). In the Android app, Drive sign-in is still being built; until then, create an encrypted backup and pick Drive in the share menu.

## Phone and browser are separate

Data in the Android app and data in a browser don't sync. To move between them, make an encrypted backup on one and restore it on the other.
