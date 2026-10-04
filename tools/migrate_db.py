"""One-off: convert the old PythonAnywhere database.db into waste/data.json.

    python3 tools/migrate_db.py "Old waste system/database.db" waste/data.json

Timestamps are already JST in the old database (PRAGMA user_version = 1), so they
are copied as they are. Entry ids, tank ids and solvent order are kept.
"""
import json
import sqlite3
import sys


def main(src, dst):
    conn = sqlite3.connect(src)
    conn.row_factory = sqlite3.Row
    if conn.execute("PRAGMA user_version").fetchone()[0] < 1:
        sys.exit("database.db still has UTC timestamps; open it once with the old app first")

    tanks = [{"id": t["tank_id"], "type": t["waste_type"], "archived": bool(t["archived"])}
             for t in conn.execute("SELECT * FROM tanks ORDER BY tank_id")]

    entries = []
    for g in conn.execute("SELECT * FROM entry_groups ORDER BY logged_at, id"):
        solvents = [{
            "name": s["solvent"],
            "L": s["solvent_L"],
            "solute": s["solute"] or "",
            "conc": s["solute_g_per_L"],
        } for s in conn.execute("SELECT * FROM entry_solvents WHERE group_id = ? ORDER BY id", (g["id"],))]
        if solvents:  # the old app only ever showed groups that had solvents
            entries.append({"id": g["id"], "tank": g["tank_id"], "by": g["logged_by"],
                            "at": g["logged_at"], "solvents": solvents})

    feedback = [{"id": c["id"], "text": c["comment"].replace("\r\n", "\n"), "at": c["created_at"]}
                for c in conn.execute("SELECT * FROM comments ORDER BY created_at, id")]

    data = {"version": 1, "tanks": tanks, "entries": entries, "feedback": feedback}
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
    n_sol = sum(len(e["solvents"]) for e in entries)
    print(f"{len(tanks)} tanks, {len(entries)} entries ({n_sol} solvent lines), {len(feedback)} feedback -> {dst}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
