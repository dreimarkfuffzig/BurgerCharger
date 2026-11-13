#!/usr/bin/env python3
"""Baut data/sites.json: Tesla Supercharger + Restaurants/Läden im Umkreis.

Quellen:
  - Supercharger: supercharge.info (allSites)
  - POIs:         OpenStreetMap via Overpass API

Aufruf:  python3 scripts/build_data.py
Nur Standardbibliothek, keine Abhängigkeiten.
"""
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date
from pathlib import Path

COUNTRIES = {
    "Germany": "DE",
    "Austria": "AT",
    "Switzerland": "CH",
    "Denmark": "DK",
    "Netherlands": "NL",
}
STATUSES = {"OPEN", "EXPANDING"}
MAX_RADIUS_M = 500          # so weit wird gesucht; die App filtert feiner
MIN_SITES_FOR_CHAIN = 4     # ab so vielen Standorten gilt eine Marke als wählbare Kette
BATCH = 120                 # Supercharger pro Overpass-Anfrage
USER_AGENT = "BurgerCharger-private/0.1"

SITES_URL = "https://supercharge.info/service/supercharge/allSites"
OVERPASS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
FOOD_AMENITIES = {"fast_food", "restaurant", "cafe", "food_court", "ice_cream"}
POI_FILTERS = [
    '["amenity"~"^(fast_food|restaurant|cafe|food_court|ice_cream)$"]',
    '["shop"~"^(bakery|supermarket|convenience)$"]',
]

OUT = Path(__file__).resolve().parent.parent / "data" / "sites.json"


def http(url, data=None, timeout=180):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def haversine(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 6371000 * 2 * math.asin(math.sqrt(a))


def load_sites():
    raw = json.loads(http(SITES_URL, timeout=90))
    sites = []
    for s in raw:
        addr = s.get("address") or {}
        cc = COUNTRIES.get(addr.get("country"))
        gps = s.get("gps") or {}
        if not cc or s.get("status") not in STATUSES or "latitude" not in gps:
            continue
        # "Koblenz, Germany - Metternich" -> "Koblenz – Metternich"
        name = s.get("name", "").replace(f', {addr["country"]}', "").replace(" - ", " – ")
        sites.append({
            "id": s["id"],
            "name": name,
            "street": addr.get("street", ""),
            "city": addr.get("city", ""),
            "cc": cc,
            "lat": round(gps["latitude"], 6),
            "lon": round(gps["longitude"], 6),
            "stalls": s.get("stallCount") or 0,
            "kw": s.get("powerKilowatt") or 0,
            "pois": [],
        })
    return sites


def overpass(query):
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for attempt in range(3):
        for url in OVERPASS:
            try:
                res = json.loads(http(url, data=body))
                if "elements" in res:
                    return res["elements"]
                last = "Antwort ohne 'elements'"
            except Exception as e:  # Timeout, 429, 504 ... nächsten Server probieren
                last = f"{url}: {e}"
                print(f"    ! {last}", file=sys.stderr)
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"Overpass nicht erreichbar: {last}")


def fetch_pois(sites):
    elements = {}
    for i in range(0, len(sites), BATCH):
        chunk = sites[i:i + BATCH]
        parts = [
            f'nwr(around:{MAX_RADIUS_M},{s["lat"]},{s["lon"]}){flt};'
            for s in chunk for flt in POI_FILTERS
        ]
        q = f'[out:json][timeout:170];({"".join(parts)});out center tags;'
        print(f"  Overpass {i + 1}–{i + len(chunk)} von {len(sites)} …", flush=True)
        for e in overpass(q):
            elements[(e["type"], e["id"])] = e
        time.sleep(2)
    return list(elements.values())


def norm(s):
    return " ".join(s.lower().replace("’", "'").split())


def assign(sites, elements):
    # Grobes Raster, damit nicht jeder POI gegen jeden Standort gerechnet wird
    grid = defaultdict(list)
    for s in sites:
        grid[(round(s["lat"], 1), round(s["lon"], 1))].append(s)

    labels = defaultdict(lambda: defaultdict(int))   # key -> Anzeigename -> Häufigkeit
    for e in elements:
        t = e.get("tags") or {}
        lat = e.get("lat") or (e.get("center") or {}).get("lat")
        lon = e.get("lon") or (e.get("center") or {}).get("lon")
        name = t.get("brand") or t.get("name")
        if lat is None or not name:
            continue
        if t.get("disused") == "yes" or t.get("access") == "private":
            continue
        key = t.get("brand:wikidata") or ("n:" + norm(name))
        cat = t.get("amenity") if t.get("amenity") in FOOD_AMENITIES else t.get("shop")
        if not cat:
            continue
        cy, cx = round(lat, 1), round(lon, 1)
        for dy in (-0.1, 0, 0.1):
            for dx in (-0.1, 0, 0.1):
                for s in grid.get((round(cy + dy, 1), round(cx + dx, 1)), ()):
                    d = haversine(s["lat"], s["lon"], lat, lon)
                    if d > MAX_RADIUS_M:
                        continue
                    poi = {"k": key, "n": t.get("name") or name, "c": cat,
                           "d": round(d), "lat": round(lat, 6), "lon": round(lon, 6)}
                    if t.get("opening_hours"):
                        poi["oh"] = t["opening_hours"]
                    s["pois"].append(poi)
                    labels[key][t.get("brand") or name] += 1
    # Dieselbe Kette taucht teils mit, teils ohne Wikidata-ID auf -> zusammenführen
    by_name = {norm(label): key for key, names in labels.items() if not key.startswith("n:")
               for label in names}
    for s in sites:
        for p in s["pois"]:
            target = by_name.get(p["k"][2:]) if p["k"].startswith("n:") else None
            if target:
                for label, n in labels.pop(p["k"], {}).items():
                    labels[target][label] += n
                p["k"] = target
        s["pois"].sort(key=lambda p: p["d"])
    return labels


def build_chains(sites, labels):
    per_chain = defaultdict(set)
    cats = defaultdict(lambda: defaultdict(int))
    for s in sites:
        for p in s["pois"]:
            per_chain[p["k"]].add(s["id"])
            cats[p["k"]][p["c"]] += 1
    chains = []
    for key, ids in per_chain.items():
        if len(ids) < MIN_SITES_FOR_CHAIN:
            continue
        label = max(labels[key].items(), key=lambda kv: kv[1])[0]
        cat = max(cats[key].items(), key=lambda kv: kv[1])[0]
        chains.append({"k": key, "label": label, "cat": cat, "sites": len(ids)})
    chains.sort(key=lambda c: -c["sites"])
    return chains


def main():
    print("Lade Supercharger von supercharge.info …")
    sites = load_sites()
    print(f"  {len(sites)} Standorte in {', '.join(COUNTRIES.values())}")
    print("Lade POIs aus OpenStreetMap …")
    elements = fetch_pois(sites)
    print(f"  {len(elements)} OSM-Objekte")
    # Schutz gegen kaputte Läufe: lieber alte Daten behalten als leere veröffentlichen
    if len(sites) < 300 or len(elements) < 2000:
        sys.exit(f"Unplausibel wenige Daten ({len(sites)} Standorte, {len(elements)} POIs) – Abbruch.")
    labels = assign(sites, elements)
    chains = build_chains(sites, labels)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "generated": date.today().isoformat(),
        "maxRadius": MAX_RADIUS_M,
        "chains": chains,
        "sites": sites,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Geschrieben: {OUT} ({OUT.stat().st_size / 1024:.0f} kB), {len(chains)} Ketten")


if __name__ == "__main__":
    main()
