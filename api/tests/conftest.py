# Autor: Matheus C. Pestana
"""Os módulos gravam em `store.DATA`, lido de URUTAU_DATA na importação: aponta para uma pasta temporária
antes de qualquer `import app...`. Nada aqui precisa de dongle, Docker ou rede."""
import os
import sys
import tempfile
from pathlib import Path

os.environ["URUTAU_DATA"] = tempfile.mkdtemp(prefix="urutau-test-")
os.environ.pop("READSB_LAT", None)
os.environ.pop("READSB_LON", None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
