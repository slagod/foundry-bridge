# CLAUDE.md — foundry-bridge

Most między lokalnymi skryptami a otwartym światem FoundryVTT. Opis, API i bezpieczeństwo:
`README.md`. Klienci: `../rpg-maps` (`rpgmaps push`), wkrótce generatory aktorów/przedmiotów.

- `src/foundry_bridge/` — `server.py` (aiohttp: HTTP dla skryptów, WS dla modułu),
  `client.py` (tylko stdlib — klienci nie potrzebują aiohttp), `cli.py`, `config.py` (klucz/port).
- `module/` — moduł Foundry (v12–v13), `scripts/bridge.js` bez kroku budowania.
- Lista operacji jest w dwóch miejscach: `OPS` w `__init__.py` i `OPS` w `bridge.js` — zmieniaj razem.
- **Nie dodawaj operacji wykonujących dowolny kod** (eval, Macro, `executeScript`). To świadoma granica.
- Wiedza o systemie gry (wfrp4e) nie trafia tutaj — tylko do narzędzi generujących treść.
- Testy: `uv run python -m unittest discover -s tests`; JS: `node --check module/scripts/bridge.js`
  i `tests/fake-foundry.mjs` (e2e na atrapie). Prawdziwe Foundry: `vtt.slagod.dev` (node5).
- Nie commituj bez potwierdzenia. Release i repo na GitHubie — tylko na polecenie.
- Docs i commity po polsku, kod i komentarze po angielsku.
