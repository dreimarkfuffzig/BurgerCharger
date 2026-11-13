# BurgerCharger

Private iPhone-Web-App (PWA): zeigt Tesla Supercharger, bei denen eine gewählte Kette (Burger King,
McDonald's, …) in Laufweite liegt, wahlweise nur entlang einer Route. Navigiert wird im Tesla-Navi; die App
ist nur der Planer, aus dem man den Stopp ans Auto weitergibt.

- Live: https://dreimarkfuffzig.github.io/BurgerCharger/
- Repo: https://github.com/dreimarkfuffzig/BurgerCharger (öffentlich, GitHub Pages aus `main`, Wurzelverzeichnis)

## Aufbau

Bewusst **ohne Build-Schritt und ohne Abhängigkeiten** (auf dem Entwicklungsrechner ist kein Node installiert).

| Datei | Zweck |
|---|---|
| `index.html`, `style.css`, `app.js` | Die App. `app.js` ist ein ES-Modul, MapLibre GL JS 4.7.1 kommt per CDN (unpkg). |
| `data/sites.json` | Vorberechnete Daten: alle Supercharger mit ihren POIs im 500-m-Umkreis. Wird generiert, nicht von Hand bearbeiten. |
| `scripts/build_data.py` | Erzeugt `data/sites.json`. Nur Python-Standardbibliothek. |
| `scripts/make_icon.py` | Zeichnet die App-Icons in `icons/` (reines Python, kein PIL). |
| `.github/workflows/update-data.yml` | Baut die Daten montags 03:17 UTC neu und committet sie. Auch manuell startbar. |
| `manifest.webmanifest`, `.nojekyll` | PWA-Manifest; `.nojekyll` schaltet Jekyll auf GitHub Pages ab. |

Es gibt keinen Service Worker (bewusst, um veraltete Caches zu vermeiden); die App braucht Netz.

## Daten

- **Supercharger:** `https://supercharge.info/service/supercharge/allSites`, gefiltert auf Status `OPEN`/`EXPANDING`
  und die Länder DE, AT, CH, DK, NL (`COUNTRIES` im Skript). OSM taugt dafür nicht: dort sind Supercharger und
  Destination Charger vermischt und Standorte mehrfach erfasst.
- **POIs:** OpenStreetMap über Overpass. Pro Supercharger `nwr(around:500,lat,lon)` für
  `amenity=fast_food|restaurant|cafe|food_court|ice_cream` und `shop=bakery|supermarket|convenience`.
  Achtung: `around` mit mehreren Koordinatenpaaren wäre eine Linie, deshalb eine Anweisung pro Standort.
- **Ketten:** Schlüssel ist `brand:wikidata`, sonst `n:<normalisierter Name>`; gleichnamige Einträge ohne
  Wikidata-ID werden der Kette zugeschlagen. Wählbar ist eine Kette ab 4 Standorten (`MIN_SITES_FOR_CHAIN`).
- **Format `sites.json`:** `{generated, maxRadius, chains:[{k,label,cat,sites}], sites:[{id,name,street,city,cc,lat,lon,stalls,kw,pois:[{k,n,c,d,lat,lon,oh?}]}]}`.
  `d` ist die Luftlinie in Metern (bei Flächen zum Mittelpunkt), `oh` die OSM-Öffnungszeiten.
- Die öffentlichen Overpass-Server sind langsam und liefern oft 502/504/Timeouts. Das Skript probiert vier
  Server reihum mit Wiederholungen; ein Lauf dauert 10–15 Minuten. Bei unplausibel wenigen Daten bricht es ab,
  damit die alten Daten erhalten bleiben.

Stand 13.11.2026: 524 Supercharger, 87 Ketten; in 200 m haben 58 einen Burger King, 127 einen McDonald's.

## App-Logik (`app.js`)

- Zustand im Objekt `state`; `compute()` berechnet Treffer und Kartenmarker neu, `renderResults()` die Liste.
- Treffer = Supercharger mit mindestens einem POI einer gewählten Kette innerhalb des Fußweg-Radius; mit Route
  zusätzlich höchstens `corridor` km Luftlinie von der Route entfernt. Sortierung nach Streckenkilometer.
- Routing: OSRM-Demoserver mit `alternatives=3`. Jede Route bekommt eine eigene `info`-Map (Abstand und
  Position jedes Standorts, `projectOnRoute`). Mit Zwischenstopp (`state.via`) liefert OSRM keine Alternativen.
- Ortssuche: Photon (komoot), auf die Region begrenzt (`BBOX`).
- Karte: OpenFreeMap-Stil „liberty“. Marker-Arten: `hit` (rot), `far` (Treffer abseits der Route, blass), `none` (grau).
- Auswahl, Radius und Korridor liegen in `localStorage` (`burgercharger.v1`).
- Externe Texte (OSM, Photon) nur über `textContent`/`el()` einsetzen, nie als HTML.

Stolperfalle: `map.flyTo({padding})` setzt den Kartenrand dauerhaft, spätere `fitBounds` passen dann nicht mehr.
Deshalb `offset: sheetOffset()` bei `flyTo` und `padding` nur bei `fitBounds`.

## Entwickeln und veröffentlichen

```sh
python3 -m http.server 8765        # lokal testen: http://localhost:8765
python3 scripts/build_data.py      # Daten neu bauen (10–15 min)
git push                           # veröffentlicht; Pages braucht 1–2 Minuten
```

Push läuft über HTTPS mit der `gh`-Anmeldung (im Repo lokal als Credential-Helper eingetragen); in `gh` muss
dafür der Account `dreimarkfuffzig` aktiv sein (`gh auth switch`). Für Änderungen an der Workflow-Datei braucht
das Token die Berechtigung `workflow`.

Standortabfrage funktioniert nur über HTTPS oder `localhost`.

## Offen / Ideen

- Auf dem iPhone noch nicht bestätigt: Darstellung, Antippen von Markern und Alternativlinien, und ob
  „Teilen / an Tesla“ (teilt einen Apple-Maps-Link) von der Tesla-App direkt als Ziel angenommen wird.
- Fußweg ist Luftlinie; dazwischen kann eine Autobahn liegen. Mögliche Verbesserung: echte Fußweg-Distanz.
- Öffnungszeiten werden nur angezeigt, nicht ausgewertet („jetzt geöffnet“ bzw. zur Ankunftszeit).
- Fahrtrichtung wird nicht berücksichtigt (Rastanlage auf der Gegenseite).
- Weitere Länder: `COUNTRIES` im Skript und `BBOX` in `app.js` erweitern.
