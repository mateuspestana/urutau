# Autor: Matheus C. Pestana
"""Gera HTML autônomo do estudo de alcance."""
from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any


def build_range_html(data: dict[str, Any]) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    generated = datetime.now(UTC).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
    rx = data.get("receiver") or {}
    return f"""<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Urutau · estudo de alcance ADS-B</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    :root {{
      --bg:#0b0e12; --panel:#12161c; --line:#243041; --text:#e7eef7;
      --muted:#8b9bb0; --amber:#e8a838; --mint:#3ddeb5; --red:#ff6b6b;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --sans: system-ui, Segoe UI, Helvetica, sans-serif;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin:0; background:var(--bg); color:var(--text);
      font-family:var(--mono); font-size:13px;
    }}
    header {{
      padding:1.2rem 1.4rem; border-bottom:1px solid var(--line);
      display:flex; flex-wrap:wrap; gap:1rem; justify-content:space-between;
    }}
    h1 {{ font-family:var(--sans); margin:0; font-size:1.4rem; }}
    .muted {{ color:var(--muted); }}
    .stats {{
      display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr));
      gap:.6rem; padding:1rem 1.4rem;
    }}
    .card {{
      background:var(--panel); border:1px solid var(--line); padding:.7rem .8rem;
    }}
    .card b {{ display:block; font-size:1.2rem; color:var(--mint); margin-top:.2rem; }}
    #map {{ height:62vh; min-height:420px; border-top:1px solid var(--line); border-bottom:1px solid var(--line); }}
    .legend {{
      padding:1rem 1.4rem; display:flex; flex-wrap:wrap; gap:1rem; align-items:center;
    }}
    .sw {{ width:10px; height:10px; display:inline-block; margin-right:.35rem; }}
    footer {{ padding:1rem 1.4rem; color:var(--muted); }}
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Estudo de alcance ADS-B</h1>
      <p class="muted">{(rx.get("address") or "Receptor")} · gerado {generated}</p>
      <p class="muted">lat {rx.get("lat")} · lon {rx.get("lon")}</p>
    </div>
    <div class="muted">
      Contorno = máximo km por azimute (1°)<br/>
      Verde = 1ª visão · Vermelho = sumiu
    </div>
  </header>
  <div class="stats" id="stats"></div>
  <div id="map"></div>
  <div class="legend">
    <span><i class="sw" style="background:var(--amber)"></i>Receptor</span>
    <span><i class="sw" style="background:var(--mint)"></i>1ª visão / contorno</span>
    <span><i class="sw" style="background:var(--red)"></i>Última visão</span>
  </div>
  <footer>Urutau · estação RTL-SDR · dados embutidos neste arquivo</footer>
  <script>
    const DATA = {payload};
    const rx = DATA.receiver || {{ lat: 0, lon: 0 }};
    const s = DATA.stats || {{}};
    document.getElementById('stats').innerHTML = [
      ['Máx km', DATA.max_km],
      ['Média máx', DATA.avg_max_km],
      ['P50 máx', DATA.p50_km],
      ['Setores', DATA.sectors_hit + '/360'],
      ['Aeronaves', s.aircraft_tracked],
      ['Posições', s.positions],
      ['Ativas agora', DATA.active_now],
    ].map(([k,v]) => `<div class="card">${{k}}<b>${{v ?? '—'}}</b></div>`).join('');

    const map = L.map('map').setView([rx.lat, rx.lon], 10);
    L.tileLayer('https://{{s}}.tile.openstreetmap.fr/hot/{{z}}/{{x}}/{{y}}.png', {{
      attribution: '&copy; OSM · Humanitarian',
      maxZoom: 19,
      subdomains: 'abc',
    }}).addTo(map);

    L.circleMarker([rx.lat, rx.lon], {{
      radius: 9, color: '#e8a838', fillColor: '#e8a838', fillOpacity: 1, weight: 2
    }}).bindPopup('<b>Receptor</b><br/>' + (rx.address || '')).addTo(map);

    const outline = DATA.outline || [];
    if (outline.length > 2) {{
      L.polygon(outline.map(p => [p.lat, p.lon]), {{
        color: '#e85d2a', weight: 3, fillColor: '#ff6b35', fillOpacity: 0.38, opacity: 0.95
      }}).bindPopup('Contorno de alcance').addTo(map);
      try {{ map.fitBounds(L.latLngBounds(outline.map(p => [p.lat, p.lon])), {{ padding: [30,30] }}); }} catch(e) {{}}
    }}

    (DATA.first_contacts || []).slice(-120).forEach(p => {{
      L.circleMarker([p.lat, p.lon], {{
        radius: 4, color: '#3ddeb5', fillColor: '#3ddeb5', fillOpacity: 0.75, weight: 1
      }}).bindPopup(`<b>1ª visão</b> ${{p.flight || p.hex}}<br/>${{p.km}} km · az ${{p.bearing}}°`).addTo(map);
    }});
    (DATA.last_contacts || []).slice(-120).forEach(p => {{
      L.circleMarker([p.lat, p.lon], {{
        radius: 4, color: '#ff6b6b', fillColor: '#ff6b6b', fillOpacity: 0.75, weight: 1
      }}).bindPopup(`<b>Sumiu</b> ${{p.flight || p.hex}}<br/>${{p.km}} km · ${{p.duration_s ?? '?'}}s`).addTo(map);
    }});
  </script>
</body>
</html>
"""
