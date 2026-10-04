# Lab-management

Web tools for Shimoyama Lab (下山研究室). Everything is a static site on GitHub Pages, so there's no server to renew
and nothing expires.

- **Lab home:** <https://purin1999.github.io/Lab-management/>, which links to the two apps below
- **Research Progress dashboard:** <https://purin1999.github.io/Research-dashboard/> (in its own repository,
  [purin1999/Research-dashboard](https://github.com/purin1999/Research-dashboard))
- **Lab Waste Tracker:** <https://purin1999.github.io/Lab-management/waste/>

## Lab Waste Tracker

This replaces the old Flask app that ran on PythonAnywhere (kept for reference in `Old waste system/`). All of its
data (tanks, entries and feedback) was carried over from `database.db`, and the 様式2の2 Word form uses the same
templates and comes out identical to the old one.

What it does (same rules as before):

- **Tanks:** one tab per active tank, with fill level (max **10 L**) and composition by solvent.
- **Log waste:** date thrown, then one or more solvents with volume, plus an optional solute and its amount in g/L or
  g (g is converted to g/L). Entries are checked before saving:
  - total ≤ 10 L
  - **k** tank: non-water solvents ≤ 2.5 L
  - **f-OH** tank: water ≤ 2.5 L
- **Copy / Edit / Del** on every entry. *Copy* refills the form for a repeat pour.
- **📄 Word form:** fills `waste/templates/<type>.docx` (様式2の2) with the tank's entries, plus 搬入月日 / 搬入者名 /
  容器番号. Templates exist for **k** and **f-OH**.
- **⇩ CSV** export per tank.
- **⚙︎ Settings** per tank: archive (once collected), rename (number / waste type), delete.
- **📊 Report:** lab-wide solvent totals for active tanks (archived ones are excluded), and every entry plus solvent
  totals per tank, ready to print.
- **💬 Feedback** page.
- **Discord alert** when a tank goes past 9 L (see setup below).

### How it works

```
index.html                    lab home page
waste/index.html, app.js      the waste tracker (no build step, no dependencies)
waste/form.js                 fills the Word template (port of the old build_form_docx)
waste/data.json               ALL waste data: tanks, entries, feedback
waste/templates/*.docx        様式2の2 templates, one per waste type
tools/migrate_db.py           one-off: old database.db -> waste/data.json
tools/waste-alert.mjs         Discord alert, run by .github/workflows/waste-alert.yml
```

Anyone can view. To make a change, a lab member signs in with a GitHub token. Each change (log, edit, delete,
tank settings, feedback) reads the latest `waste/data.json`, applies the change and commits it through the GitHub
API. If two people save at the same moment, the second one is automatically re-applied on top of the first, so
nothing is lost. Every change is a commit with the person's GitHub username, so the
[commit history of `waste/data.json`](https://github.com/purin1999/Lab-management/commits/main/waste/data.json) is
a complete audit log, and anything deleted by mistake can be restored from it.

The sign-in is shared with the Research dashboard (both are on `purin1999.github.io`), so one token on a device works
for both apps, as long as the token can write to both repositories.

## One-time setup (admin)

1. **Turn on GitHub Pages:** *Settings → Pages → Build and deployment → Deploy from a branch*, branch `main`,
   folder `/ (root)`. The site appears at <https://purin1999.github.io/Lab-management/>.
2. **Invite each lab member:** *Settings → Collaborators → Add people* (their GitHub username). They must accept the
   invitation from their GitHub email.
3. **Discord alert (optional):** create a webhook in Discord (*Server settings → Integrations → Webhooks*), then in
   GitHub go to *Settings → Secrets and variables → Actions → New repository secret*, name `DISCORD_WEBHOOK`, and
   paste the webhook URL. Without the secret, the alert job just logs a warning.

## Lab member setup (once per device)

1. Accept the collaborator invitation (GitHub email).
2. Create a token: <https://github.com/settings/tokens/new?scopes=public_repo&description=Lab%20management>
   (*Tokens (classic)*, with the **public_repo** box ticked), pick an expiration or *No expiration*, then tap
   **Generate token** and copy it.
   > GitHub's newer *fine-grained* tokens only work for repositories you own, so they can't be used to write to
   > `purin1999/…` as a collaborator. Use the classic token above. (The owner can use either.)
3. Open the waste tracker, tap **Sign in**, paste the token. Check **👤 → Your name on entries**: that name is
   written as 投入者氏名 on the Word form.
4. On iPhone: Safari → Share → **Add to Home Screen**. The Home Screen app has its own storage, so sign in there once
   too.

## Running locally

```bash
python3 -m http.server 8000
# open http://localhost:8000/ and http://localhost:8000/waste/
```

## Re-running the migration

`waste/data.json` was created from `Old waste system/database.db` with:

```bash
python3 tools/migrate_db.py "Old waste system/database.db" waste/data.json
```

Don't run it again now that the new app is in use: it would overwrite everything logged since.
