#!/usr/bin/env python3
"""
One-time backfill: resolve service_locations to a Google place_id + coordinate +
canonical address, and write them back in place. Run LOCALLY.

  python3 scripts/backfill_service_geocode.py            # maintenance set only (default)
  python3 scripts/backfill_service_geocode.py --all      # every active customer location
  python3 scripts/backfill_service_geocode.py --dry-run  # list targets, no geocode/write
  python3 scripts/backfill_service_geocode.py --limit 25 # cap this run

Reads from .env.local:
  NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_MAPS_API_KEY

Notes
- Resumable: only touches active service_locations where place_id IS NULL.
- Writes by id (these existing rows just GAIN a place_id) — this is the one-time
  admin backfill. Ongoing create/update goes through public.upsert_service_location.
- Every result is validated against the SE-GA/NE-FL service bbox; out-of-area
  results are flagged (place_id recorded, coordinate withheld) so a bad geocode
  can't reach the routing map. Missing city/state/zip are filled from Google's
  canonical components (existing values are never overwritten).
- Emits scripts/service_geocode_review.csv (needs_review + out_of_area) + a summary.
"""
import os, sys, json, time, csv, ssl, urllib.request, urllib.parse, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def load_env(path):
    env = {}
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env

ENV  = load_env(os.path.join(ROOT, ".env.local"))
SUPA = ENV.get("NEXT_PUBLIC_SUPABASE_URL", "").rstrip("/")
SKEY = ENV.get("SUPABASE_SERVICE_ROLE_KEY", "")
GKEY = ENV.get("GOOGLE_MAPS_API_KEY", "")

try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:
    CTX = ssl._create_unverified_context()

BBOX = {"min_lat": 30.2, "max_lat": 32.7, "min_lng": -82.4, "max_lng": -80.6}
def in_bbox(lat, lng):
    return lat is not None and BBOX["min_lat"] <= lat <= BBOX["max_lat"] and BBOX["min_lng"] <= lng <= BBOX["max_lng"]

def rest(method, path, params=None, body=None, prefer=None, schema=None):
    qs = "?" + urllib.parse.urlencode(params, doseq=True) if params else ""
    req = urllib.request.Request(f"{SUPA}/rest/v1/{path}{qs}",
                                 data=(json.dumps(body).encode() if body is not None else None),
                                 method=method)
    req.add_header("apikey", SKEY); req.add_header("Authorization", f"Bearer {SKEY}")
    req.add_header("Content-Type", "application/json")
    if prefer: req.add_header("Prefer", prefer)
    if schema:
        req.add_header("Accept-Profile" if method == "GET" else "Content-Profile", schema)
    try:
        with urllib.request.urlopen(req, context=CTX) as r:
            t = r.read().decode(); return r.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def maintenance_location_ids():
    """Service locations referenced by ANY maintenance task (the canonical 683).
    Uses maintenance.tasks; falls back to the schedules view if tasks isn't exposed."""
    for table in ("tasks", "v_task_schedules_with_context"):
        ids, off, ok = set(), 0, True
        while True:
            st, rows = rest("GET", table, {"select": "service_location_id",
                            "limit": "1000", "offset": str(off)}, schema="maintenance")
            if not isinstance(rows, list):
                ok = False; break
            ids.update(r["service_location_id"] for r in rows if r.get("service_location_id"))
            if len(rows) < 1000: break
            off += 1000
        if ok:
            return ids
    raise SystemExit("Could not read maintenance task/service_location ids")

def unresolved_locations(retry=False):
    out, off = [], 0
    while True:
        params = {"select": "id,account_id,street,city,state,zip",
                  "is_active": "eq.true", "order": "id", "limit": "1000", "offset": str(off)}
        if retry:
            # fresh rows AND previously flagged ones (out_of_area / needs_review)
            params["or"] = "(place_id.is.null,geocode_status.in.(out_of_area,needs_review))"
        else:
            params["place_id"] = "is.null"
        st, rows = rest("GET", "service_locations", params)
        if not isinstance(rows, list): raise SystemExit(f"service_locations error {st}: {rows}")
        out.extend(rows)
        if len(rows) < 1000: break
        off += 1000
    return out

def geocode(addr):
    # NOTE: do NOT constrain to administrative_area:GA — the service area spans GA
    # AND NE-Florida (Fernandina Beach, Yulee). A GA-only filter forces FL addresses
    # to fall back to the GA centroid. We bias with `bounds` and validate with the bbox.
    url = "https://maps.googleapis.com/maps/api/geocode/json?" + urllib.parse.urlencode({
        "address": addr, "key": GKEY,
        "components": "country:US",
        "bounds": f'{BBOX["min_lat"]},{BBOX["min_lng"]}|{BBOX["max_lat"]},{BBOX["max_lng"]}',
    })
    with urllib.request.urlopen(urllib.request.Request(url), context=CTX) as r:
        d = json.loads(r.read().decode())
    if d.get("status") != "OK" or not d.get("results"):
        return {"status": d.get("status", "ERROR")}
    res = d["results"][0]; loc = res["geometry"]["location"]
    comp = {t: c for c in res.get("address_components", []) for t in c["types"]}
    def g(t, key="long_name"): return comp[t][key] if t in comp else None
    street = " ".join(x for x in [g("street_number"), g("route")] if x) or None
    return {
        "status": "OK",
        "place_id": res.get("place_id"),
        "lat": loc["lat"], "lng": loc["lng"],
        "loc_type": res["geometry"].get("location_type"),
        "partial": res.get("partial_match", False),
        "formatted": res.get("formatted_address"),
        "city": g("locality") or g("postal_town") or g("sublocality"),
        "state": g("administrative_area_level_1", "short_name"),
        "zip": g("postal_code"),
        "street": street,
    }

def classify(g):
    if g["status"] != "OK":
        return "needs_review"
    if not in_bbox(g["lat"], g["lng"]):
        return "out_of_area"
    if g["loc_type"] in ("ROOFTOP", "RANGE_INTERPOLATED") and not g["partial"]:
        return "ok"
    return "needs_review"

def main():
    argv = sys.argv[1:]
    maint_only = "--all" not in argv
    dry = "--dry-run" in argv
    retry = "--retry" in argv
    limit = None
    if "--limit" in argv:
        limit = int(argv[argv.index("--limit") + 1])
    sleep = 0.1

    if not SUPA or not SKEY:
        raise SystemExit("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local")
    if not dry and not GKEY:
        raise SystemExit("Missing GOOGLE_MAPS_API_KEY in .env.local (add a Geocoding-enabled key).")

    targets = unresolved_locations(retry=retry)
    if maint_only:
        mset = maintenance_location_ids()
        targets = [t for t in targets if t["id"] in mset]
    if limit:
        targets = targets[:limit]

    print(f"scope={'maintenance' if maint_only else 'all'}  targets={len(targets)}  dry_run={dry}")
    if dry:
        for t in targets[:10]:
            print(f"  id={t['id']:>6} {t['street']}, {t.get('city')}, {t.get('state')} {t.get('zip')}")
        print(f"  ...({len(targets)} total)")
        return

    counts = {"ok": 0, "needs_review": 0, "out_of_area": 0, "error": 0}
    seen_place = {}   # place_id -> [ids]  (collision detector)
    review = []
    for i, t in enumerate(targets, 1):
        parts = [t["street"]]
        if t.get("city"): parts.append(t["city"])
        parts.append(t.get("state") or "GA")
        if t.get("zip"): parts.append(t["zip"])
        addr = ", ".join(p for p in parts if p)
        try:
            g = geocode(addr)
        except Exception as e:
            counts["error"] += 1; review.append([t["id"], addr, "error", str(e)[:80], "", "", ""]); time.sleep(sleep); continue

        status = classify(g)
        counts[status] = counts.get(status, 0) + 1
        patch = {"geocode_source": "google", "geocode_status": status}
        if g["status"] == "OK" and status != "out_of_area":
            # Confident in-bbox resolution: store identity + coord, fill missing
            # canonical address fields. Only here do we persist a place_id.
            patch["place_id"] = g["place_id"]; patch["place_provider"] = "google"
            patch["latitude"] = g["lat"]; patch["longitude"] = g["lng"]
            patch["geocoded_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            seen_place.setdefault(g["place_id"], []).append(t["id"])
            if t.get("city") is None and g.get("city"):   patch["city"] = g["city"]
            if t.get("state") is None and g.get("state"):  patch["state"] = g["state"]
            if t.get("zip") is None and g.get("zip"):      patch["zip"] = g["zip"]
        else:
            # out_of_area / no result: record the flag only. No place_id (the match
            # is the wrong place) and no coordinate — so the row surfaces for address
            # cleanup and can't pollute the unique(place_id) index.
            patch["place_id"] = None; patch["latitude"] = None; patch["longitude"] = None
        st, _ = rest("PATCH", "service_locations", {"id": f"eq.{t['id']}"}, body=patch, prefer="return=minimal")
        if st not in (200, 204):
            counts["error"] += 1; review.append([t["id"], addr, "write_error", str(st), "", "", ""])
        if status in ("needs_review", "out_of_area"):
            review.append([t["id"], addr, status, g.get("formatted", ""), g.get("loc_type", ""),
                           g.get("place_id", ""), g["status"]])
        if i % 50 == 0:
            print(f"  {i}/{len(targets)}  {counts}")
        time.sleep(sleep)

    dups = {pid: ids for pid, ids in seen_place.items() if len(ids) > 1}
    review_path = os.path.join(ROOT, "scripts", "service_geocode_review.csv")
    with open(review_path, "w", newline="") as f:
        w = csv.writer(f); w.writerow(["id", "query", "status", "formatted/detail", "loc_type", "place_id", "api_status"])
        w.writerows(review)

    print("\n=== DONE ===")
    print(f"  resolved ok      : {counts['ok']}")
    print(f"  needs_review     : {counts['needs_review']}")
    print(f"  out_of_area      : {counts['out_of_area']}")
    print(f"  errors           : {counts['error']}")
    print(f"  place_id collisions (same address, >1 row): {len(dups)}")
    for pid, ids in list(dups.items())[:15]:
        print(f"    {pid} -> service_location ids {ids}")
    print(f"  review CSV: {review_path}")

if __name__ == "__main__":
    main()
