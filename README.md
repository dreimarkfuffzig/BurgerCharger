# BurgerCharger

Zeigt Tesla Supercharger, bei denen eine gewählte Kette (Burger King, McDonald's, …) in Laufweite liegt –
wahlweise nur entlang einer Route. Reine statische Web-App ohne Build-Schritt.

## Lokal starten

```sh
python3 -m http.server 8765
# dann http://localhost:8765 öffnen
```

## Daten aktualisieren

```sh
python3 scripts/build_data.py
```

Lädt die Supercharger von supercharge.info und alle Restaurants, Cafés, Bäckereien und Supermärkte im
500-m-Umkreis aus OpenStreetMap (Overpass) und schreibt `data/sites.json`. Dauert wegen der öffentlichen
Overpass-Server etwa 10–15 Minuten. Länder, Suchradius und Kategorien stehen oben im Skript.

## Externe Dienste (alle ohne Konto/API-Key)

- Karte: OpenFreeMap + MapLibre GL JS
- Ortssuche: Photon (komoot)
- Routing: OSRM-Demoserver
