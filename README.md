# Bayazit Fußball-Ergebnisse

Seite: https://fussball.kompassapps.de

- `index.html` – Ergebnis-Seite (liest nur gespeicherte Daten aus `data/`)
- `scripts/sammeln.mjs` – holt beendete Spiele mit allen Details und Tabellen
- `.github/workflows/ergebnisse.yml` – startet den Sammler automatisch mehrmals am Tag
- `chronik/` – Fußball-Chronik

Datenquelle: API-Football über den Cloudflare-Worker `fussball-live` (der kennt den Schlüssel).
