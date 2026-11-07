"""Local bridge between scripts and a FoundryVTT world open in the GM's browser."""

__version__ = "0.3.0"

DEFAULT_PORT = 8765

# Operations the Foundry module implements. Deliberately no "run arbitrary JS":
# anyone with the key could otherwise do anything in the world.
OPS = frozenset({
    "status",
    "files.upload",
    "documents.upsert",
    "documents.find",
    "documents.delete",
    "documents.get",
    "packs.list",
    "packs.export",
    "files.fetch",
    "documents.images",
})
