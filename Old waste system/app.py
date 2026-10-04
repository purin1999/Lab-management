from flask import Flask, render_template, request, redirect, url_for, session, Response
import sqlite3, os, csv, io, json, urllib.request, re, zipfile
from urllib.parse import quote
from datetime import datetime, timezone, timedelta
from xml.sax.saxutils import escape

app = Flask(__name__)
app.secret_key = "lab_waste_2026"

DB = os.path.join(os.path.dirname(__file__), "database.db")
FORM_ROWS = 36  # blank rows the printed 様式2の2 sheet holds
# One template per waste type — each has the 貯留区分 circle drawn over its own type.
FORM_TEMPLATES = {
    "f-OH": os.path.join(os.path.dirname(__file__), "f-OH_template.docx"),
    "k": os.path.join(os.path.dirname(__file__), "k_template.docx"),
}

LAB_PASSWORD = "scfgel2011"
DISCORD_WEBHOOK = "https://discord.com/api/webhooks/1521458077474492489/qoRpMhKqdeeE9GxYQxec0cgaDb_Cvw5iWBUkV-Rq_RpsVUBDs_WKKdSF1IHy1sU41IeK"
ALERT_THRESHOLD_L = 9.0

SOLVENTS = ["water", "ethanol", "acetone", "hexane", "cyclohexane", "methanol"]

WASTE_TYPES = ["k", "f-OH", "f", "f-N", "h-L", "h-a", "a", "a-Hg",
               "b", "b-f", "b-p", "d", "e", "g", "i", "j", "p", "Cyanide"]

SOLVENT_COLORS = {
    "water":       "#4cc9f0",
    "ethanol":     "#4895ef",
    "acetone":     "#f72585",
    "hexane":      "#f9c74f",
    "cyclohexane": "#fb8500",
    "methanol":    "#8338ec",
}
FALLBACK_COLORS = ["#adb5bd", "#6c757d", "#90e0ef", "#caf0f8"]

TANK_MAX_L = 10.0

# SQLite's CURRENT_TIMESTAMP is always UTC, so timestamps are written in JST explicitly.
JST = timezone(timedelta(hours=9))


def now_jst():
    return datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S")


def entry_timestamp(date_str):
    """User-chosen disposal date, kept with the current time so same-day
    entries still sort in the order they were logged. Falls back to today."""
    now = datetime.now(JST)
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return now.strftime("%Y-%m-%d %H:%M:%S")
    return f"{date_str} {now:%H:%M:%S}"


def send_discord_alert(tank_id, waste_type, total_L):
    msg = f"⚠️ Tank {tank_id} ({waste_type}) is almost full: {total_L:.3f} / {TANK_MAX_L} L"
    data = json.dumps({"content": msg}).encode()
    req = urllib.request.Request(DISCORD_WEBHOOK, data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        resp = urllib.request.urlopen(req, timeout=5)
        print(f"[Discord alert] status={resp.status}")
    except urllib.error.HTTPError as e:
        print(f"[Discord alert HTTP error] {e.code} {e.read().decode()}")
    except Exception as e:
        print(f"[Discord alert error] {e}")


def get_db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tanks (
                tank_id TEXT PRIMARY KEY,
                waste_type TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS entry_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tank_id TEXT NOT NULL,
                logged_by TEXT NOT NULL,
                logged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (tank_id) REFERENCES tanks(tank_id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS entry_solvents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                solvent TEXT NOT NULL,
                solvent_L REAL NOT NULL,
                solute TEXT,
                solute_g_per_L REAL,
                FOREIGN KEY (group_id) REFERENCES entry_groups(id)
            )
        """)
        old_cols = [r[1] for r in conn.execute("PRAGMA table_info(entries)").fetchall()]
        if old_cols and "solvent" in old_cols:
            for e in conn.execute("SELECT * FROM entries").fetchall():
                cur = conn.execute(
                    "INSERT INTO entry_groups (tank_id, logged_by, logged_at) VALUES (?, ?, ?)",
                    (e["tank_id"], e["logged_by"], e["logged_at"])
                )
                conn.execute(
                    "INSERT INTO entry_solvents (group_id, solvent, solvent_L, solute, solute_g_per_L) VALUES (?, ?, ?, ?, ?)",
                    (cur.lastrowid, e["solvent"], e["solvent_L"], e["solute"], e["solute_g_per_L"])
                )
            conn.execute("DROP TABLE entries")

        tank_cols = [r[1] for r in conn.execute("PRAGMA table_info(tanks)").fetchall()]
        if "archived" not in tank_cols:
            conn.execute("ALTER TABLE tanks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                comment TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Rows written before the JST fix were stamped in UTC. Shift them once;
        # user_version guards against the migration running twice.
        if conn.execute("PRAGMA user_version").fetchone()[0] < 1:
            conn.execute("UPDATE entry_groups SET logged_at = datetime(logged_at, '+9 hours')")
            conn.execute("UPDATE comments SET created_at = datetime(created_at, '+9 hours')")
            conn.execute("PRAGMA user_version = 1")


def get_tank_summary(conn, tank_id):
    rows = conn.execute("""
        SELECT es.solvent, SUM(es.solvent_L) as vol
        FROM entry_solvents es
        JOIN entry_groups eg ON es.group_id = eg.id
        WHERE eg.tank_id = ?
        GROUP BY es.solvent
    """, (tank_id,)).fetchall()
    by_solvent = {r["solvent"]: round(r["vol"], 4) for r in rows}
    total = round(sum(by_solvent.values()), 4)
    water = by_solvent.get("water", 0)
    return {"total": total, "water": water, "by_solvent": by_solvent}


def get_group_volumes(conn, tank_id):
    rows = conn.execute("""
        SELECT eg.id as gid,
               SUM(es.solvent_L) as total,
               SUM(CASE WHEN es.solvent='water' THEN es.solvent_L ELSE 0 END) as water
        FROM entry_groups eg
        JOIN entry_solvents es ON eg.id = es.group_id
        WHERE eg.tank_id = ?
        GROUP BY eg.id
    """, (tank_id,)).fetchall()
    return {str(r["gid"]): {"total": round(r["total"], 4), "water": round(r["water"], 4)}
            for r in rows}


def get_groups(conn, tank_id, limit=None, date_from=None, date_to=None, order="DESC"):
    id_q = "SELECT id FROM entry_groups WHERE tank_id = ?"
    params = [tank_id]
    if date_from:
        id_q += " AND DATE(logged_at) >= ?"
        params.append(date_from)
    if date_to:
        id_q += " AND DATE(logged_at) <= ?"
        params.append(date_to)
    id_q += f" ORDER BY logged_at {order}, id {order}"
    if limit:
        id_q += f" LIMIT {limit}"

    ids = [r[0] for r in conn.execute(id_q, params).fetchall()]
    if not ids:
        return []

    ph = ",".join("?" * len(ids))
    rows = conn.execute(f"""
        SELECT eg.id AS group_id, eg.logged_by, eg.logged_at,
               es.solvent, es.solvent_L, es.solute, es.solute_g_per_L
        FROM entry_groups eg
        JOIN entry_solvents es ON eg.id = es.group_id
        WHERE eg.id IN ({ph})
        ORDER BY eg.logged_at {order}, eg.id {order}, es.id ASC
    """, ids).fetchall()

    groups, order_list = {}, []
    for r in rows:
        gid = r["group_id"]
        if gid not in groups:
            groups[gid] = {"id": gid, "logged_by": r["logged_by"],
                           "logged_at": r["logged_at"], "solvents": []}
            order_list.append(gid)
        groups[gid]["solvents"].append({
            "solvent": r["solvent"],
            "solvent_L": r["solvent_L"],
            "solute": r["solute"] or "",
            "solute_g_per_L": "" if r["solute_g_per_L"] is None else r["solute_g_per_L"],
        })
    return [groups[gid] for gid in order_list]


def validate_entry(conn, tank_id, new_solvents, replace_id=None):
    """Returns an error string or None if valid."""
    tank = conn.execute("SELECT waste_type FROM tanks WHERE tank_id = ?", (tank_id,)).fetchone()
    if not tank:
        return "Tank not found."
    waste_type = tank["waste_type"]

    summary = get_tank_summary(conn, tank_id)
    replace_vol = replace_water = 0
    if replace_id:
        rv = conn.execute("""
            SELECT SUM(solvent_L) as total,
                   SUM(CASE WHEN solvent='water' THEN solvent_L ELSE 0 END) as water
            FROM entry_solvents WHERE group_id = ?
        """, (replace_id,)).fetchone()
        replace_vol = rv["total"] or 0
        replace_water = rv["water"] or 0

    base_total = summary["total"] - replace_vol
    base_water = summary["water"] - replace_water
    new_total = sum(s["vol"] for s in new_solvents)
    new_water = sum(s["vol"] for s in new_solvents if s["solvent"] == "water")

    final_total = base_total + new_total
    final_water = base_water + new_water

    if final_total > TANK_MAX_L + 0.001:
        remaining = TANK_MAX_L - base_total
        return (f"Tank overflow: adding {new_total:.3f} L would bring total to "
                f"{final_total:.3f} L (max {TANK_MAX_L} L). "
                f"Only {remaining:.3f} L remaining.")

    final_organic = final_total - final_water
    if waste_type == "k" and final_organic > 2.5 + 0.001:
        return (f"k tank: non-water solvents cannot exceed 2.5 L. "
                f"After this entry non-water would be {final_organic:.3f} L.")
    if waste_type == "f-OH" and final_water > 2.5 + 0.001:
        return (f"f-OH tank: water cannot exceed 2.5 L. "
                f"After this entry water would be {final_water:.3f} L.")

    return None


@app.route("/auth", methods=["POST"])
def auth():
    if request.form.get("password") == LAB_PASSWORD:
        session["auth"] = True
        return redirect(url_for("index"))
    return redirect(url_for("index") + "?auth_error=1")


@app.route("/", methods=["GET", "POST"])
def index():
    if request.method == "POST" and "username" in request.form:
        session["user"] = request.form["username"].strip()
        return redirect(url_for("index"))
    if "auth" not in session:
        wrong = request.args.get("auth_error") == "1"
        return render_template("login.html", mode="password", wrong=wrong)
    if "user" not in session:
        return render_template("login.html", mode="name")

    error = request.args.get("error", "")
    error_tank = request.args.get("error_tank", "")

    with get_db() as conn:
        tanks = conn.execute("SELECT * FROM tanks WHERE archived = 0 ORDER BY tank_id").fetchall()
        archived_tanks = conn.execute("SELECT * FROM tanks WHERE archived = 1 ORDER BY tank_id").fetchall()
        groups_by_tank, summaries, group_vols, tank_types = {}, {}, {}, {}
        for t in tanks:
            tid = t["tank_id"]
            groups_by_tank[tid] = get_groups(conn, tid, limit=30)
            summaries[tid] = get_tank_summary(conn, tid)
            group_vols[tid] = get_group_volumes(conn, tid)
            tank_types[tid] = t["waste_type"]
        archived_summaries = {t["tank_id"]: get_tank_summary(conn, t["tank_id"]) for t in archived_tanks}

    return render_template("index.html",
                           tanks=tanks, archived_tanks=archived_tanks,
                           archived_summaries=archived_summaries,
                           groups_by_tank=groups_by_tank,
                           summaries=summaries, group_vols=group_vols,
                           tank_types=tank_types,
                           solvent_colors=SOLVENT_COLORS,
                           fallback_colors=FALLBACK_COLORS,
                           tank_max_l=TANK_MAX_L,
                           waste_types=WASTE_TYPES, solvents=SOLVENTS,
                           user=session["user"], today=now_jst()[:10],
                           error=error, error_tank=error_tank)


@app.route("/add_tank", methods=["POST"])
def add_tank():
    tank_id = request.form["tank_id"].strip().zfill(2)
    waste_type = request.form["waste_type"]
    with get_db() as conn:
        conn.execute("INSERT OR IGNORE INTO tanks (tank_id, waste_type) VALUES (?, ?)",
                     (tank_id, waste_type))
    return redirect(url_for("index") + f"#tank-{tank_id}")


@app.route("/archive_tank/<tank_id>", methods=["POST"])
def archive_tank(tank_id):
    if request.form.get("confirm") != "archive":
        return redirect(url_for("index") + f"#tank-{tank_id}")
    with get_db() as conn:
        conn.execute("UPDATE tanks SET archived = 1 WHERE tank_id = ?", (tank_id,))
    return redirect(url_for("index"))


@app.route("/unarchive_tank/<tank_id>", methods=["POST"])
def unarchive_tank(tank_id):
    with get_db() as conn:
        conn.execute("UPDATE tanks SET archived = 0 WHERE tank_id = ?", (tank_id,))
    return redirect(url_for("index") + f"#tank-{tank_id}")


@app.route("/rename_tank/<tank_id>", methods=["POST"])
def rename_tank(tank_id):
    if request.form.get("confirm") != "rename":
        return redirect(url_for("index") + f"#tank-{tank_id}")
    new_id = request.form.get("new_tank_id", "").strip().zfill(2)
    new_type = request.form.get("new_waste_type", "").strip()

    with get_db() as conn:
        if new_id != tank_id:
            exists = conn.execute("SELECT 1 FROM tanks WHERE tank_id = ?", (new_id,)).fetchone()
            if exists:
                err = quote(f"Tank {new_id} already exists.")
                return redirect(url_for("index") + f"#tank-{tank_id}?error={err}&error_tank={tank_id}")
        conn.execute("UPDATE tanks SET tank_id = ?, waste_type = ? WHERE tank_id = ?",
                     (new_id, new_type, tank_id))
        conn.execute("UPDATE entry_groups SET tank_id = ? WHERE tank_id = ?", (new_id, tank_id))
    return redirect(url_for("index") + f"#tank-{new_id}")


@app.route("/delete_tank/<tank_id>", methods=["POST"])
def delete_tank(tank_id):
    if request.form.get("confirm") != "delete":
        return redirect(url_for("index") + f"#tank-{tank_id}")
    with get_db() as conn:
        group_ids = [r[0] for r in conn.execute(
            "SELECT id FROM entry_groups WHERE tank_id = ?", (tank_id,)).fetchall()]
        if group_ids:
            ph = ",".join("?" * len(group_ids))
            conn.execute(f"DELETE FROM entry_solvents WHERE group_id IN ({ph})", group_ids)
            conn.execute(f"DELETE FROM entry_groups WHERE id IN ({ph})", group_ids)
        conn.execute("DELETE FROM tanks WHERE tank_id = ?", (tank_id,))
    return redirect(url_for("index"))


@app.route("/feedback", methods=["GET"])
def feedback():
    if "auth" not in session or "user" not in session:
        return redirect(url_for("index"))
    with get_db() as conn:
        comments = conn.execute("SELECT * FROM comments ORDER BY created_at DESC").fetchall()
    return render_template("feedback.html", comments=comments)


@app.route("/add_comment", methods=["POST"])
def add_comment():
    text = request.form.get("comment", "").strip()
    if text:
        with get_db() as conn:
            conn.execute("INSERT INTO comments (comment, created_at) VALUES (?, ?)",
                         (text, now_jst()))
    return redirect(url_for("feedback"))


@app.route("/add_entry", methods=["POST"])
def add_entry():
    print("[add_entry] called")
    tank_id = request.form["tank_id"]
    solvents_sel = request.form.getlist("solvent_select[]")
    solvents_other = request.form.getlist("solvent_other[]")
    volumes = request.form.getlist("solvent_L[]")
    solutes = request.form.getlist("solute[]")
    amounts = request.form.getlist("solute_amount[]")
    units = request.form.getlist("solute_unit[]")
    user = session.get("user", "unknown")
    replace_id = request.form.get("replace_group_id", "").strip()

    # Build new solvent list
    new_solvents = []
    for i in range(len(volumes)):
        sel = solvents_sel[i] if i < len(solvents_sel) else ""
        other = solvents_other[i].strip() if i < len(solvents_other) else ""
        solvent = other if sel == "other" else sel
        vol_str = volumes[i].strip()
        if not solvent or not vol_str:
            continue
        solute = solutes[i].strip() if i < len(solutes) else ""
        amount_str = amounts[i].strip() if i < len(amounts) else ""
        unit = units[i] if i < len(units) else "g/L"
        vol = float(vol_str)

        # The solute amount may be typed as a plain mass; store it as g/L either way.
        conc = None
        if amount_str:
            amount = float(amount_str)
            conc = round(amount / vol, 4) if unit == "g" and vol > 0 else amount

        new_solvents.append({
            "solvent": solvent, "vol": vol,
            "solute": solute or None,
            "conc": conc,
        })

    with get_db() as conn:
        err = validate_entry(conn, tank_id, new_solvents, replace_id or None)
        if err:
            return redirect(url_for("index") + f"#tank-{tank_id}"
                            + f"?error={quote(err)}&error_tank={tank_id}")

        summary_before = get_tank_summary(conn, tank_id)
        before_total = summary_before["total"]
        if replace_id:
            rv = conn.execute("SELECT SUM(solvent_L) as total FROM entry_solvents WHERE group_id = ?",
                              (replace_id,)).fetchone()
            before_total -= rv["total"] or 0
            conn.execute("DELETE FROM entry_solvents WHERE group_id = ?", (replace_id,))
            conn.execute("DELETE FROM entry_groups WHERE id = ?", (replace_id,))

        cur = conn.execute(
            "INSERT INTO entry_groups (tank_id, logged_by, logged_at) VALUES (?, ?, ?)",
            (tank_id, user, entry_timestamp(request.form.get("entry_date", "").strip()))
        )
        group_id = cur.lastrowid
        for s in new_solvents:
            conn.execute("""
                INSERT INTO entry_solvents (group_id, solvent, solvent_L, solute, solute_g_per_L)
                VALUES (?, ?, ?, ?, ?)
            """, (group_id, s["solvent"], s["vol"], s["solute"], s["conc"]))

        after_total = before_total + sum(s["vol"] for s in new_solvents)
        print(f"[Discord check] before={before_total} after={after_total} threshold={ALERT_THRESHOLD_L}")
        if before_total <= ALERT_THRESHOLD_L < after_total:
            tank_row = conn.execute("SELECT waste_type FROM tanks WHERE tank_id = ?",
                                    (tank_id,)).fetchone()
            send_discord_alert(tank_id, tank_row["waste_type"], after_total)

    return redirect(url_for("index") + f"#tank-{tank_id}")


@app.route("/delete_group/<int:group_id>", methods=["POST"])
def delete_group(group_id):
    with get_db() as conn:
        tank_id = conn.execute("SELECT tank_id FROM entry_groups WHERE id = ?", (group_id,)).fetchone()
        conn.execute("DELETE FROM entry_solvents WHERE group_id = ?", (group_id,))
        conn.execute("DELETE FROM entry_groups WHERE id = ?", (group_id,))
    tid = tank_id["tank_id"] if tank_id else ""
    return redirect(url_for("index") + f"#tank-{tid}")


@app.route("/report")
def report():
    with get_db() as conn:
        tanks = conn.execute("SELECT * FROM tanks ORDER BY tank_id").fetchall()
        report_by_tank = {}
        for t in tanks:
            tid = t["tank_id"]
            groups = get_groups(conn, tid, order="ASC")
            totals = {}
            for g in groups:
                for s in g["solvents"]:
                    totals[s["solvent"]] = totals.get(s["solvent"], 0) + s["solvent_L"]
            report_by_tank[tid] = {
                "groups": groups, "totals": totals,
                "waste_type": t["waste_type"],
            }

    # Archived tanks have already been collected for treatment, so their volume
    # is no longer held in the lab and is left out of the summary.
    active = [t for t in tanks if not t["archived"]]
    grand = {}
    for t in active:
        for solvent, vol in report_by_tank[t["tank_id"]]["totals"].items():
            grand[solvent] = grand.get(solvent, 0) + vol
    grand_totals = {k: round(v, 4) for k, v in sorted(grand.items(), key=lambda kv: -kv[1])}
    grand_total = round(sum(grand_totals.values()), 4)

    return render_template("report.html", tanks=tanks, report_by_tank=report_by_tank,
                           grand_totals=grand_totals, grand_total=grand_total,
                           active_count=len(active),
                           solvent_colors=SOLVENT_COLORS,
                           fallback_colors=FALLBACK_COLORS)


@app.route("/export/<tank_id>")
def export(tank_id):
    with get_db() as conn:
        groups = get_groups(conn, tank_id, order="ASC")
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Date", "User", "Group", "Solvent", "Solvent (L)", "Solute", "Solute (g/L)"])
    for g in groups:
        for s in g["solvents"]:
            writer.writerow([g["logged_at"][:10], g["logged_by"], g["id"],
                             s["solvent"], s["solvent_L"],
                             s["solute"] or "", s["solute_g_per_L"] or ""])
    return Response(output.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f"attachment; filename=tank_{tank_id}_log.csv"})


CELL_RE = re.compile(r"<w:tc>.*?</w:tc>", re.S)
PARA_RE = re.compile(r"<w:p\b([^>]*)/>")
ROW_RE = re.compile(r"<w:tr\b.*?</w:tr>", re.S)
RSID_RE = re.compile(r'\s(?:w14:paraId|w14:textId)="[^"]*"')


def form_num(v):
    """0.05 -> '0.05', 2.0 -> '2' (matches how the sheet is filled in by hand)."""
    return "" if v is None or v == "" else f"{float(v):g}"


def form_date(logged_at):
    y, m, d = logged_at[:10].split("-")
    return f"{y}.{int(m)}.{int(d)}"


def fill_row(row_xml, values):
    """Put one string into each of the row's six cells, skipping empty ones."""
    out, last = [], 0
    for cell, val in zip(CELL_RE.finditer(row_xml), values):
        out.append(row_xml[last:cell.start()])
        xml = cell.group(0)
        if val:
            run = ('<w:r><w:rPr><w:rFonts w:hint="eastAsia"/></w:rPr>'
                   f'<w:t xml:space="preserve">{escape(str(val))}</w:t></w:r>')
            xml = PARA_RE.sub(lambda m: f"<w:p{m.group(1)}>{run}</w:p>", xml, count=1)
        out.append(xml)
        last = cell.end()
    out.append(row_xml[last:])
    return "".join(out)


def header_date(iso):
    """'2026-07-22' -> '2026年7月22日'; blank keeps the empty 年月日 skeleton."""
    if not iso:
        return "　年　月　日"
    y, m, d = iso.split("-")
    return f"{y}年{int(m)}月{int(d)}日"


def build_form_docx(template, groups, delivery_date="", deliverer="", container=""):
    """Fill a 様式2の2 template with this tank's entries."""
    with zipfile.ZipFile(template) as zin:
        infos = zin.infolist()
        parts = {i.filename: zin.read(i.filename) for i in infos}
    doc = parts["word/document.xml"].decode("utf-8")

    for token, value in (("{{DATE}}", header_date(delivery_date)),
                         ("{{NAME}}", deliverer),
                         ("{{CONTAINER}}", container)):
        doc = doc.replace(token, escape(value))

    t_start = doc.index("<w:tbl>")
    t_end = doc.index("</w:tbl>", t_start) + len("</w:tbl>")
    tbl = doc[t_start:t_end]
    header_row, blank_row, total_row = ROW_RE.findall(tbl)
    preamble = tbl[:tbl.index(header_row)]
    # Cloned rows must not reuse the template row's revision ids.
    blank_row = RSID_RE.sub("", blank_row)

    lines, total = [], 0.0
    for g in groups:
        date = form_date(g["logged_at"])
        for i, s in enumerate(g["solvents"]):
            total += s["solvent_L"]
            lines.append([
                date if i == 0 else "",              # 年・月・日
                s["solvent"],                        # 内容物名
                form_num(s["solvent_L"]),            # 量（l）
                form_num(s["solute_g_per_L"]),       # 濃度（g/l）
                g["logged_by"] if i == 0 else "",    # 投入者氏名
                s["solute"] or "",                   # 備考
            ])

    body = [fill_row(blank_row, v) for v in lines]
    body += [blank_row] * max(0, FORM_ROWS - len(lines))
    total_row = fill_row(total_row, ["", "", form_num(round(total, 4)), "", "", ""])

    doc = (doc[:t_start] + preamble + header_row + "".join(body)
           + total_row + "</w:tbl>" + doc[t_end:])

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in infos:
            data = doc.encode("utf-8") if info.filename == "word/document.xml" \
                else parts[info.filename]
            zout.writestr(info, data)
    return buf.getvalue()


@app.route("/form/<tank_id>")
def form_request(tank_id):
    if "auth" not in session or "user" not in session:
        return redirect(url_for("index"))
    with get_db() as conn:
        tank = conn.execute("SELECT * FROM tanks WHERE tank_id = ?", (tank_id,)).fetchone()
        groups = get_groups(conn, tank_id, order="ASC")
    if not tank:
        return redirect(url_for("index"))
    return render_template("form_request.html", tank=tank,
                           lines=sum(len(g["solvents"]) for g in groups),
                           supported=tank["waste_type"] in FORM_TEMPLATES,
                           form_rows=FORM_ROWS,
                           today=now_jst()[:10], user=session["user"])


@app.route("/export_docx/<tank_id>")
def export_docx(tank_id):
    with get_db() as conn:
        tank = conn.execute("SELECT waste_type FROM tanks WHERE tank_id = ?", (tank_id,)).fetchone()
        groups = get_groups(conn, tank_id, order="ASC")
    if not tank or tank["waste_type"] not in FORM_TEMPLATES:
        return Response(
            f"No 様式2の2 template for waste type '{tank['waste_type'] if tank else '?'}'. "
            f"Templates exist for: {', '.join(FORM_TEMPLATES)}.",
            status=400, mimetype="text/plain; charset=utf-8")

    data = build_form_docx(FORM_TEMPLATES[tank["waste_type"]], groups,
                           request.args.get("date", "").strip(),
                           request.args.get("name", "").strip(),
                           request.args.get("container", "").strip())
    return Response(
        data,
        mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename=waste_form_tank_{tank_id}.docx"})


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("index"))


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=5000, debug=True)
