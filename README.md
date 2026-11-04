# foundry-bridge

Skrypty na moim Macu tworzą i aktualizują dokumenty w otwartym świecie FoundryVTT
(sceny, dzienniki, aktorów, przedmioty, tabele) i wgrywają pliki do `Data/`, bez
ręcznego kopiowania i makr.

```
skrypt ──HTTP + klucz──▶ foundry-bridge (127.0.0.1:8765) ◀──WebSocket + klucz── moduł w przeglądarce GM ──▶ świat
```

Moduł Foundry działa tylko w przeglądarce klienta i niczego nie wystawia, więc to on łączy
się z bridge'em. Warunek: świat otwarty jako GM na tym samym Macu.

## Uruchomienie

```sh
uv sync
uv run foundry-bridge serve          # zostaw w tle; przy pierwszym starcie tworzy klucz
uv run foundry-bridge key --copy     # klucz do schowka
```

W Foundry: moduł **Foundry Bridge** włączony w świecie → Configure Settings → Module
Settings → *Connect to the bridge* ✓, *Bridge key* ← wklej. Ustawienia URL i klucza są
per przeglądarka (`client`), gracze ich nie widzą. Po połączeniu pojawia się
„connected to the bridge”, a `uv run foundry-bridge status` pokazuje świat.

## Klient (Python, sama biblioteka standardowa)

```python
from foundry_bridge.client import Bridge
fb = Bridge()
fb.upload("rpg-maps/inn/map.webp", Path("map.webp"))
j = fb.upsert("JournalEntry", "rpgmaps:inn", {"name": "Inn", "pages": [...]}, folder="rpg-maps")
fb.upsert("Scene", "rpgmaps:inn", {..., "journal": j["id"]}, folder="rpg-maps")
```

- `key` (`<narzędzie>:<id>`) trafia do `flags["foundry-bridge"].key`; ten sam klucz
  aktualizuje istniejący dokument zamiast tworzyć kopię.
- Wysłane kolekcje osadzone (ściany i światła sceny, przedmioty aktora, strony dziennika)
  **zastępują** stare; niewysłane zostają — tokeny postawione przez GM przeżyją ponowny push.
- Znajomość systemu (np. struktura `Actor` w `wfrp4e`) należy do narzędzia, które generuje
  treść, nie do bridge'a.

## API

| | |
|---|---|
| `GET /status` | bridge, czy świat podłączony, jaki (system, wersja Foundry) |
| `POST /rpc` `{op, args}` | jedna operacja |
| `POST /batch` `{ops: [...]}` | po kolei, stop na pierwszym błędzie |

Operacje: `status`, `files.upload {path, b64, mime}`, `documents.upsert {type, key, data, folder?}`,
`documents.find {type, key?}`, `documents.delete {type, key}`.
Kody: 401 zły klucz, 400 nieznana operacja, 503 brak świata, 502 błąd w Foundry, 504 brak odpowiedzi.

## Bezpieczeństwo

- Bridge słucha tylko na `127.0.0.1`; klucz (`~/.config/foundry-bridge/key`, 0600) wymagany
  po obu stronach.
- **Nie ma operacji „wykonaj JS”** i typu `Macro` — zakres to biała lista typów dokumentów
  (`Scene`, `JournalEntry`, `Actor`, `Item`, `RollTable`, `Playlist`, `Cards`) i katalogów
  uploadu (ustawienie świata, domyślnie `rpg-maps, bridge`).
- Operacje wykonuje tylko klient GM, który sam włączył połączenie.

## Testy

```sh
uv run python -m unittest discover -s tests       # bridge + klient z udawanym modułem
node tests/fake-foundry.mjs ws://127.0.0.1:8765/ws  # prawdziwy bridge.js na atrapie API Foundry
```

`fake-foundry.mjs` po SIGINT wypisuje stan atrapy świata. Nie zastępuje testu w prawdziwym
Foundry — atrapa udaje tylko to, czego dotyka `bridge.js`.

## Wydanie modułu

`./bin/build-module.sh` → `dist/module.json` + `dist/module.zip`, potem
`gh release create vX.Y.Z dist/*`. Foundry instaluje z manifestu
`https://github.com/slagod/foundry-bridge/releases/latest/download/module.json`
(repo musi być publiczne). Przy nowej wersji podbij `version` w `module/module.json`
i `src/foundry_bridge/__init__.py`.
