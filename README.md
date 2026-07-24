# Karting Klassement

Statische webpagina die heat-resultaten (PDF, IAME Series Benelux /
Camp Company timing-formaat) client-side inleest met pdf.js en optelt
tot een klassement per klasse.

## Draaien

```
python -m http.server 8123
```

en open `http://localhost:8123`.

## Stand van zaken

- Parser leest rijder, kartnummer en punten uit de PDF op basis van
  vaste kolomposities (zie `app.js`, `parseRows` / `parseTitleBlock`).
- Data wordt nu bewaard in `localStorage` van de browser (per apparaat).

## Volgende stappen

- **Supabase**: `localStorage` vervangen door een Supabase-tabel zodat
  het klassement gedeeld en persistent is over apparaten. `loadHeats()`
  en `saveHeats()` in `app.js` zijn de enige plekken die dan moeten
  wijzigen naar Supabase-calls.
- **GitHub**: repo naar GitHub pushen en hosten via GitHub Pages
  (zoals `dfkkarting.github.io/TimingPro`).
