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
- **Almost-full warning** when an entry takes a tank past 9 L.

### How it works

```
index.html                    lab home page
waste/index.html, app.js      the waste tracker (no build step, no dependencies)
waste/form.js                 fills the Word template (port of the old build_form_docx)
waste/data.json               ALL waste data: tanks, entries, feedback
waste/templates/*.docx        様式2の2 templates, one per waste type
tools/migrate_db.py           one-off: old database.db -> waste/data.json
```

Anyone can view. To make changes, lab members sign in with **one shared lab token** that the admin creates and
hands out (the waste data lives in the admin's repository, so nobody needs their own GitHub account for it). Each
person also enters their **name**, which is saved on their entries (投入者氏名 on the Word form) and in the commit
message. Feedback stays anonymous.

Each change (log, edit, delete, tank settings, feedback) reads the latest `waste/data.json`, applies the change and
commits it through the GitHub API. If two people save at the same moment, the second change is automatically
re-applied on top of the first, so nothing is lost. The
[commit history of `waste/data.json`](https://github.com/purin1999/Lab-management/commits/main/waste/data.json) is
a complete log, and anything deleted by mistake can be restored from it.

The lab token is stored separately from the Research dashboard's sign-in, so it never signs anyone in to the
dashboard (where it would let them edit the admin's own progress). The dashboard keeps using each student's own
GitHub account.

## One-time setup (admin)

1. **Turn on GitHub Pages:** *Settings → Pages → Build and deployment → Deploy from a branch*, branch `main`,
   folder `/ (root)`. The site appears at <https://purin1999.github.io/Lab-management/>.
2. **Create the lab token** at <https://github.com/settings/personal-access-tokens/new>:
   - *Token name*: `Lab waste tracker`
   - *Expiration*: the longest you're comfortable with
   - *Repository access*: **Only select repositories** → `purin1999/Lab-management` (only this one)
   - *Repository permissions → Contents*: **Read and write** (nothing else)
3. **Sign in** on the waste tracker with that token and your name, then **👤 → Invite a lab member → Copy sign-in
   link**. Send the link to lab members privately (LINE, Slack, email). Opening it fills in the token, so they only
   type their name.

**Keep the token inside the lab.** Anyone who has it can change files in this repository (the history keeps
everything, so changes can always be undone). Never put it in a file in this repository or post it publicly: GitHub
detects leaked tokens and revokes them.

**When the token expires or leaks:** delete it on <https://github.com/settings/personal-access-tokens>, create a new
one the same way, sign in with it, and send the new sign-in link around. Everyone else sees *"The lab token was not
accepted"* until they open the new link.

## Lab member setup (once per device)

1. Open the sign-in link from the admin (or tap **Sign in** and paste the token).
2. Enter your name as it should appear on the Word form (e.g. `Purin` or `後藤 照希`) and tap **Sign in**.
3. On iPhone: Safari → Share → **Add to Home Screen**. The Home Screen app has its own storage, so open the sign-in
   link there once too (or paste the token).

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
