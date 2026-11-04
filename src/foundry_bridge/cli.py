"""foundry-bridge serve | status | key [--copy]"""
from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys

from . import config


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="foundry-bridge", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve", help="run the bridge on 127.0.0.1 (creates the key on first run)")
    s.add_argument("--port", type=int, default=None)
    sub.add_parser("status", help="is a Foundry world connected, which one")
    k = sub.add_parser("key", help="the key to paste into the module settings")
    k.add_argument("--copy", action="store_true", help="copy to the clipboard instead of printing")
    args = p.parse_args(argv)

    if args.cmd == "serve":
        from .server import serve
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
        key = config.ensure_key()
        port = args.port or config.port()
        print(f"foundry-bridge on http://127.0.0.1:{port}  (module URL: ws://127.0.0.1:{port}/ws)")
        print(f"key: {config.KEY_FILE}  — `foundry-bridge key --copy` to paste it into the module")
        serve(key, port)
    elif args.cmd == "status":
        from .client import Bridge, BridgeError
        try:
            print(json.dumps(Bridge().status(), indent=1, ensure_ascii=False))
        except BridgeError as e:
            sys.exit(str(e))
    elif args.cmd == "key":
        key = config.ensure_key()
        if args.copy:
            subprocess.run(["pbcopy"], input=key.encode(), check=True)
            print("key copied to the clipboard")
        else:
            print(key)


if __name__ == "__main__":
    main()
