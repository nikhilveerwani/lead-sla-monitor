"""Generate SYNTHETIC leads and call logs for the Lead SLA Monitor demo.

Nothing here is real. The data is shaped so the report has something to find:
  * leads arrive all day, with an evening peak; night leads wait for the morning shift,
  * reps differ: a couple are consistently slow, one team is short-staffed on Saturdays,
  * calling stops on Sundays,
  * ~3% of leads are never called, and ~1% have a call logged BEFORE the lead was created
    (the same person registered earlier: the SLA rule must ignore that call),
  * breached leads carry a reason, as a team would fill in on the sheet.

Each day is seeded from its date, so history is stable as the window rolls forward.
Usage: python pipeline/generate_synthetic.py --out data --days 45
"""
import argparse
import csv
import datetime as dt
import os
import random

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
TEAMS = {
    "Team A": ["Aarav", "Diya", "Kabir"],
    "Team B": ["Meera", "Rohan", "Sana"],
    "Team C": ["Ishaan", "Tara", "Vivaan"],
    "Team D": ["Anaya", "Dev", "Zoya"],
}
SLOW = {"Rohan": 2.6, "Vivaan": 2.0, "Zoya": 1.5}          # multiplier on time to first call
SOURCES = [("Paid search", 0.34), ("Paid social", 0.30), ("Organic", 0.16), ("Webinar", 0.12), ("Referral", 0.08)]
REASONS = ["Lead not synced to CRM", "Reassigned late", "Rep on leave", "Wrong / invalid number",
           "Called from personal phone (not logged)", "Duplicate lead"]


def pick(rng, weighted):
    r, acc = rng.random(), 0
    for v, w in weighted:
        acc += w
        if r < acc:
            return v
    return weighted[-1][0]


def next_shift_start(t: dt.datetime, rng) -> dt.datetime:
    """Calling hours 09:30-21:00 IST, Monday-Saturday. Push t into the next open slot."""
    local = t.astimezone(IST)
    while True:
        open_ = local.replace(hour=9, minute=30, second=0, microsecond=0)
        close = local.replace(hour=21, minute=0, second=0, microsecond=0)
        if local.weekday() == 6 or local >= close:
            local = (local + dt.timedelta(days=1)).replace(hour=9, minute=30, second=0)
            local += dt.timedelta(minutes=rng.uniform(0, 50))
            continue
        if local < open_:
            local = open_ + dt.timedelta(minutes=rng.uniform(0, 50))
        return local


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data")
    ap.add_argument("--days", type=int, default=45)
    ap.add_argument("--now", help="ISO timestamp to treat as now (default: current time)")
    args = ap.parse_args()
    now = dt.datetime.fromisoformat(args.now) if args.now else dt.datetime.now(IST)
    now = now.astimezone(IST)
    os.makedirs(args.out, exist_ok=True)

    leads, calls, reasons = [], [], []
    reps = [(team, rep) for team, rs in TEAMS.items() for rep in rs]
    for back in range(args.days, -1, -1):
        day = now.date() - dt.timedelta(days=back)
        rng = random.Random(f"leads-{day.isoformat()}")
        n = int(rng.gauss(150, 18) * (0.55 if day.weekday() == 6 else 0.8 if day.weekday() == 5 else 1.0))
        for i in range(n):
            minute = int(min(1439, max(0, rng.gauss(17.5, 4.2) * 60))) if rng.random() < 0.75 else rng.randrange(1440)
            created = dt.datetime.combine(day, dt.time(minute // 60, minute % 60, rng.randrange(60)), IST)
            if created > now:
                continue
            team, rep = reps[rng.randrange(len(reps))]
            lid = f"L{day.strftime('%y%m%d')}{i:03d}"
            leads.append([lid, created.isoformat(timespec="seconds"), rep, team, pick(rng, SOURCES)])

            if rng.random() < 0.01:                               # earlier registration's call
                calls.append([lid, (created - dt.timedelta(hours=rng.uniform(2, 60))).isoformat(timespec="seconds"), rep, 41])

            never = rng.random() < 0.03
            base = rng.lognormvariate(0.6, 1.0) * SLOW.get(rep, 1.0)        # hours
            if team == "Team D" and created.weekday() == 5:
                base *= 2.5                                                   # short-staffed Saturdays
            first = next_shift_start(created + dt.timedelta(hours=min(base, 70)), rng)
            if never or first > now:
                if never and created < now - dt.timedelta(hours=24):
                    reasons.append([lid, rng.choice(REASONS)])
                continue
            t = first
            for k in range(rng.choice([1, 1, 2, 2, 3, 4])):
                if t > now:
                    break
                calls.append([lid, t.isoformat(timespec="seconds"), rep, int(rng.expovariate(1 / 90)) if rng.random() < 0.55 else 0])
                t = next_shift_start(t + dt.timedelta(hours=rng.uniform(3, 30)), rng)
            if first > created + dt.timedelta(hours=24) and rng.random() < 0.7:
                reasons.append([lid, rng.choice(REASONS)])

    def write(name, header, rows):
        with open(os.path.join(args.out, name), "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f); w.writerow(header); w.writerows(rows)

    write("leads.csv", ["lead_id", "created_at", "owner", "team", "source"], leads)
    write("calls.csv", ["lead_id", "called_at", "rep", "duration_sec"], calls)
    write("reasons.csv", ["lead_id", "reason"], reasons)
    print(f"synthetic: {len(leads)} leads, {len(calls)} calls, {len(reasons)} breach reasons, now={now.isoformat(timespec='minutes')}")


if __name__ == "__main__":
    main()
