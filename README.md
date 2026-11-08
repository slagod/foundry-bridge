# foundry-bridge

Skrypty na moim Macu tworzą i aktualizują dokumenty w otwartym świecie FoundryVTT
(sceny, dzienniki, aktorów, przedmioty, tabele) i wgrywają pliki do `Data/`, bez
ręcznego kopiowania i makr. W trakcie gry stawiają tokeny, prowadzą walkę, piszą na czacie,
pokazują graczom obrazy i dzienniki, a także słyszą, co dzieje się przy stole (zdarzenia).

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
| `GET /events?since=N&wait=S` | zdarzenia stołu po numerze `N`; `wait` — czekaj do S s na pierwsze (long-poll) |
| `POST /rpc` `{op, args}` | jedna operacja |
| `POST /batch` `{ops: [...]}` | po kolei, stop na pierwszym błędzie |

Operacje: `status`, `files.upload {path, b64, mime}`, `documents.upsert {type, key, data, folder?}`,
`documents.find {type, key?}`, `documents.delete {type, key}`,
`documents.images {type: Actor|Item, id, img?, token?}` — tylko obrazy istniejącego dokumentu świata (np. aktora
pobranego ze świata): `img` i tekstura tokenu prototypowego; ścieżki względne, inne pola nie do ruszenia
(od 0.3.0; w kliencie `fb.set_images()`).

Odczyt (np. statbloki, kompendia systemu, portrety):
`documents.get {type, ids?, folder?}` — pełne dane dokumentów świata, nie tylko utworzonych przez bridge;
`packs.list` — kompendia dozwolonych typów; `packs.export {pack, ids?}` — ich dokumenty z `uuid`;
`files.fetch {path}` — plik serwowany przez Foundry (ścieżka względna, np. `worlds/x/portrait.webp`) jako base64.
W kliencie: `fb.get()`, `fb.packs()`, `fb.export_pack()`, `fb.fetch_file()`.
Przedmioty: `documents.update {type: Actor|Item, id, data}` — pola istniejącego dokumentu świata (id, klucz
bridge'a albo uuid), bez kolekcji osadzonych; `actors.items.add {actor, items}` — dane przedmiotu albo uuid
przedmiotu z kompendium lub świata (kopia), reszta ekwipunku zostaje; `actors.items.update {actor, items: [{_id, …}]}`,
`actors.items.remove {actor, ids}`. `actor` to id, klucz albo uuid tokenu (niepowiązany aktor wroga).
W kliencie: `fb.update()`, `fb.give()`, `fb.update_items()`, `fb.take()`.

W trakcie gry (scena: id, klucz, `"active"` albo `"viewed"`):

| Operacja | Klient | |
|---|---|---|
| `chat.post {text, whisper?, speaker?, flavor?, share?}` | `fb.say()` | tekst (`**pogrubienie**`, `*kursywa*`, akapity), nigdy HTML; domyślnie szept do MG z przyciskiem „Pokaż wszystkim” |
| `tokens.create {scene, tokens}` | `fb.add_tokens()` | `actor` (id, klucz, uuid — aktor z kompendium importowany raz), `x`, `y` w px od rogu mapy albo polach z `grid: true`, `hidden`, `disposition` |
| `tokens.update / tokens.delete` | `fb.update_tokens()`, `fb.remove_tokens()` | pojedyncze tokeny, reszta sceny bez zmian |
| `packs.import {pack, ids, folder?}` | `fb.import_pack()` | dokumenty kompendium do świata |
| `scenes.activate / scenes.view {scene}` | `fb.activate()`, `fb.view()` | dla wszystkich / tylko MG |
| `combat.start {scene, tokens?, roll?}`, `combat.end {scene?}` | `fb.start_combat()`, `fb.end_combat()` | `roll`: `"npc"` albo `"all"`; koniec bez okna potwierdzenia |
| `show {img? \| journal, page?, title?, users?}` | `fb.show()` | obraz (ścieżka serwowana przez Foundry) albo dziennik/strona u graczy |
| `ui.open {type, id}` | `fb.open()` | arkusz u MG; scena — podgląd |
| `world.state` | `fb.state()` | aktywna i oglądana scena, walka (kolejność), gracze z postaciami, zaznaczone i namierzone tokeny MG, grające playlisty |
| `playlists.play {playlist, sound?}`, `playlists.stop {playlist?}` | `fb.play()`, `fb.stop()` | |

Zdarzenia (ustawienie modułu *Send table events to the bridge*, domyślnie wyłączone): `chat`, `chat.update`
(wiadomość z `rolls` i surowymi `flags` systemu — np. test broni, lokacja trafienia), `combat`, `combat.end`,
`scene`, `target`, `control`, `actor`, `token` (zmiany aktora niepowiązanego), `item.create`, `item.delete`.
Każde ma `kind`, `seq`, `at`, `scene`; bridge trzyma ostatnie 5000, numeracja od nowa po restarcie (`boot`).
W kliencie `for e in fb.listen(): …`. Co znaczy rzut, wie narzędzie systemu gry, nie bridge.

Kody: 401 zły klucz, 400 nieznana operacja, 503 brak świata, 502 błąd w Foundry, 504 brak odpowiedzi.

## Bezpieczeństwo

- Bridge słucha tylko na `127.0.0.1`; klucz (`~/.config/foundry-bridge/key`, 0600) wymagany
  po obu stronach.
- **Nie ma operacji „wykonaj JS”** i typu `Macro` — zakres to biała lista typów dokumentów
  (`Scene`, `JournalEntry`, `Actor`, `Item`, `RollTable`, `Playlist`, `Cards`) i katalogów
  uploadu (ustawienie świata, domyślnie `rpg-maps, bridge`).
- Odczyt obejmuje te same typy dokumentów; `files.fetch` tylko ścieżki względne na serwerze Foundry
  (bez schematu URL i `..`) — to, co przeglądarka GM i tak może pobrać.
- Operacje wykonuje tylko klient GM, który sam włączył połączenie.
- Czat przyjmuje tylko tekst: HTML wiadomości renderuje się u każdego gracza, więc skrypt nie może go podać.
- Zdarzenia (także szepty i ślepe rzuty) wychodzą tylko do lokalnego bridge'a i tylko po włączeniu
  w ustawieniach tej przeglądarki.

## Testy

```sh
uv run python -m unittest discover -s tests       # bridge + klient; z node także bridge.js na atrapie
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
