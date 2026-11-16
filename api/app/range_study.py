# Autor: Matheus C. Pestana
"""Estudo de alcance ADS-B: primeira/última visão e contorno polar."""
from __future__ import annotations

import asyncio
import json
import math
import time
from typing import Any

import httpx

from . import aircraftdb, flightlog, store

DATA = store.DATA / "range.json"
BINS = 360  # 1° por setor
# padrões da suavização; a pessoa ajusta na aba Alcance (config range_median_deg, range_sigma_deg, range_gap_deg)
MEDIAN_HALF = 4  # mediana circular de ±4°: derruba picos com menos de ~4° (uma aeronave só)
GAUSS_SIGMA = 2.0  # suavização final do contorno, em graus
GAP_MAX = 45  # buracos de até este tamanho (graus) são interpolados
RANGE_VIEWS = ("smooth", "raw", "both")


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    φ1, φ2 = math.radians(lat1), math.radians(lat2)
    Δλ = math.radians(lon2 - lon1)
    y = math.sin(Δλ) * math.cos(φ2)
    x = math.cos(φ1) * math.sin(φ2) - math.sin(φ1) * math.cos(φ2) * math.cos(Δλ)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def destination(lat: float, lon: float, bearing: float, km: float) -> tuple[float, float]:
    δ = km / 6371.0
    θ = math.radians(bearing)
    φ1, λ1 = math.radians(lat), math.radians(lon)
    φ2 = math.asin(math.sin(φ1) * math.cos(δ) + math.cos(φ1) * math.sin(δ) * math.cos(θ))
    λ2 = λ1 + math.atan2(
        math.sin(θ) * math.sin(δ) * math.cos(φ1),
        math.cos(δ) - math.sin(φ1) * math.sin(φ2),
    )
    return math.degrees(φ2), (math.degrees(λ2) + 540) % 360 - 180


class RangeStudy:
    def __init__(self) -> None:
        self.polar_max_km: list[float] = [0.0] * BINS
        self.polar_samples: list[int] = [0] * BINS
        self.first_contacts: list[dict[str, Any]] = []
        self.last_contacts: list[dict[str, Any]] = []
        self.active: dict[str, dict[str, Any]] = {}
        self.stats = {
            "aircraft_tracked": 0,
            "positions": 0,
            "max_km": 0.0,
            "started_at": time.time(),
            "updated_at": time.time(),
        }
        self._task: asyncio.Task | None = None
        self._load()

    def _load(self) -> None:
        if not DATA.exists():
            return
        try:
            raw = json.loads(DATA.read_text())
            self.polar_max_km = raw.get("polar_max_km") or self.polar_max_km
            self.polar_samples = raw.get("polar_samples") or self.polar_samples
            self.first_contacts = raw.get("first_contacts") or []
            self.last_contacts = raw.get("last_contacts") or []
            self.stats = raw.get("stats") or self.stats
            # não restaura active — sessão nova
        except Exception:
            pass

    def save(self) -> None:
        DATA.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "polar_max_km": self.polar_max_km,
            "polar_samples": self.polar_samples,
            "first_contacts": self.first_contacts[-500:],
            "last_contacts": self.last_contacts[-500:],
            "stats": self.stats,
        }
        DATA.write_text(json.dumps(payload))

    def reset(self) -> None:
        self.polar_max_km = [0.0] * BINS
        self.polar_samples = [0] * BINS
        self.first_contacts = []
        self.last_contacts = []
        self.active = {}
        self.stats = {
            "aircraft_tracked": 0,
            "positions": 0,
            "max_km": 0.0,
            "started_at": time.time(),
            "updated_at": time.time(),
        }
        self.save()

    def _ingest_point(
        self,
        hex_id: str,
        flight: str,
        lat: float,
        lon: float,
        rssi: float | None,
        alt: Any,
        now: float,
        is_first: bool,
    ) -> None:
        rx = store.receiver()
        if rx is None:
            return
        rx_lat, rx_lon = rx
        dist = haversine_km(rx_lat, rx_lon, lat, lon)
        brg = bearing_deg(rx_lat, rx_lon, lat, lon)
        bin_i = int(brg) % BINS
        if dist > self.polar_max_km[bin_i]:
            self.polar_max_km[bin_i] = dist
        self.polar_samples[bin_i] += 1
        self.stats["positions"] += 1
        self.stats["max_km"] = max(self.stats["max_km"], dist)
        self.stats["updated_at"] = now

        point = {
            "hex": hex_id,
            "flight": flight,
            "lat": lat,
            "lon": lon,
            "km": round(dist, 2),
            "bearing": round(brg, 1),
            "rssi": rssi,
            "alt": alt,
            "ts": now,
        }
        if is_first:
            self.first_contacts.append(point)
            if len(self.first_contacts) > 500:
                self.first_contacts = self.first_contacts[-500:]

    def snapshot_aircraft(self, aircraft: list[dict[str, Any]]) -> None:
        now = time.time()
        seen: set[str] = set()
        for a in aircraft:
            hex_id = (a.get("hex") or "").lower()
            lat, lon = a.get("lat"), a.get("lon")
            if not hex_id or lat is None or lon is None:
                continue
            try:
                lat_f, lon_f = float(lat), float(lon)
            except (TypeError, ValueError):
                continue
            seen.add(hex_id)
            flight = (a.get("flight") or hex_id).strip() if isinstance(a.get("flight"), str) else hex_id
            rssi = a.get("rssi")
            alt = a.get("alt_baro") if a.get("alt_baro") is not None else a.get("alt_geom")

            if hex_id not in self.active:
                self.active[hex_id] = {
                    "flight": flight,
                    "first_ts": now,
                    "last_ts": now,
                    "first_lat": lat_f,
                    "first_lon": lon_f,
                    "last_lat": lat_f,
                    "last_lon": lon_f,
                    "max_km": 0.0,
                    "samples": 0,
                }
                self.stats["aircraft_tracked"] += 1
                self._ingest_point(hex_id, flight, lat_f, lon_f, rssi, alt, now, is_first=True)
            else:
                self._ingest_point(hex_id, flight, lat_f, lon_f, rssi, alt, now, is_first=False)

            st = self.active[hex_id]
            st["last_ts"] = now
            st["last_lat"] = lat_f
            st["last_lon"] = lon_f
            st["flight"] = flight
            st["samples"] += 1
            rx = store.receiver()
            if rx is not None:
                st["max_km"] = max(st["max_km"], haversine_km(rx[0], rx[1], lat_f, lon_f))

        # sumiram: last contact
        gone = [h for h in list(self.active) if h not in seen]
        for hex_id in gone:
            st = self.active.pop(hex_id)
            # só registra last se ficou visível > 5s (evita flicker)
            if st["last_ts"] - st["first_ts"] < 5:
                continue
            rx = store.receiver()
            if rx is None:
                continue
            rx_lat, rx_lon = rx
            dist = haversine_km(rx_lat, rx_lon, st["last_lat"], st["last_lon"])
            brg = bearing_deg(rx_lat, rx_lon, st["last_lat"], st["last_lon"])
            self.last_contacts.append(
                {
                    "hex": hex_id,
                    "flight": st["flight"],
                    "lat": st["last_lat"],
                    "lon": st["last_lon"],
                    "km": round(dist, 2),
                    "bearing": round(brg, 1),
                    "first_lat": st["first_lat"],
                    "first_lon": st["first_lon"],
                    "duration_s": round(st["last_ts"] - st["first_ts"], 1),
                    "max_km": round(st["max_km"], 2),
                    "ts": st["last_ts"],
                }
            )
            if len(self.last_contacts) > 500:
                self.last_contacts = self.last_contacts[-500:]

    @staticmethod
    def smoothing_params(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
        """Parâmetros atuais da suavização e da vista (config), já limitados a valores que fazem sentido."""
        cfg = cfg if cfg is not None else store.load_config()

        def num(key: str, default: float, lo: float, hi: float) -> float:
            try:
                v = float(cfg.get(key, default))
            except (TypeError, ValueError):
                v = default
            return min(max(v, lo), hi)

        view = cfg.get("range_view")
        return {
            "median_deg": int(round(num("range_median_deg", MEDIAN_HALF, 0, 20))),
            "sigma_deg": round(num("range_sigma_deg", GAUSS_SIGMA, 0, 10), 1),
            "gap_deg": int(round(num("range_gap_deg", GAP_MAX, 0, 90))),
            "view": view if view in RANGE_VIEWS else "smooth",
        }

    def smoothed_km(self, median_half: int | None = None, sigma: float | None = None,
                    gap_max: int | None = None) -> list[float | None]:
        """Alcance por azimute suavizado; None onde não há dado perto.

        O máximo bruto por setor de 1° vira pico quando uma única aeronave passa longe num setor onde o
        resto do tráfego é curto. Por isso: (1) buracos de até `gap_max`° são preenchidos por interpolação
        linear circular; (2) mediana circular de ±`median_half`° derruba picos mais estreitos que isso;
        (3) média gaussiana (σ = `sigma`°) arredonda o contorno. Zero desliga a etapa. Sem argumentos usa a
        config. O máximo bruto continua em `polar_max_km` e nas estatísticas.
        """
        if median_half is None or sigma is None or gap_max is None:
            prm = self.smoothing_params()
            median_half = prm["median_deg"] if median_half is None else median_half
            sigma = prm["sigma_deg"] if sigma is None else sigma
            gap_max = prm["gap_deg"] if gap_max is None else gap_max
        raw = [k if k > 0 else None for k in self.polar_max_km]
        known = [i for i, k in enumerate(raw) if k is not None]
        if not known:
            return [None] * BINS
        filled: list[float | None] = list(raw)
        if len(known) > 1 and gap_max > 0:
            for n, i in enumerate(known):
                j = known[(n + 1) % len(known)]
                gap = (j - i) % BINS
                if 1 < gap <= gap_max + 1:
                    a, b = raw[i], raw[j]
                    for d in range(1, gap):
                        filled[(i + d) % BINS] = a + (b - a) * d / gap  # type: ignore[operator]
        med: list[float | None] = [None] * BINS
        for i in range(BINS):
            if filled[i] is None:
                continue
            if median_half <= 0:
                med[i] = filled[i]
                continue
            win = sorted(v for d in range(-median_half, median_half + 1) if (v := filled[(i + d) % BINS]) is not None)
            med[i] = win[len(win) // 2]
        if sigma <= 0:
            return med
        half = max(1, math.ceil(3 * sigma))
        kern = [math.exp(-0.5 * (d / sigma) ** 2) for d in range(-half, half + 1)]
        out: list[float | None] = [None] * BINS
        for i in range(BINS):
            if med[i] is None:
                continue
            acc = wsum = 0.0
            for d, w in zip(range(-half, half + 1), kern, strict=True):
                v = med[(i + d) % BINS]
                if v is not None:
                    acc += v * w
                    wsum += w
            out[i] = acc / wsum
        return out

    def raw_outline(self) -> list[dict[str, float]]:
        """Polígono lat/lon do alcance bruto (máximo de cada setor de 1°, sem suavizar)."""
        rx = store.receiver()
        if rx is None:
            return []
        pts = []
        for i, km in enumerate(self.polar_max_km):
            if km > 0:
                lat, lon = destination(rx[0], rx[1], float(i), km)
                pts.append({"lat": lat, "lon": lon, "km": round(km, 2), "bearing": i})
        return pts

    def outline(self) -> list[dict[str, float]]:
        """Polígono lat/lon do alcance suavizado por azimute (ver `smoothed_km`)."""
        rx = store.receiver()
        if rx is None:
            return []
        rx_lat, rx_lon = rx
        pts = []
        for i, km in enumerate(self.smoothed_km()):
            if km is None or km <= 0:
                continue
            lat, lon = destination(rx_lat, rx_lon, float(i), km)
            pts.append({"lat": lat, "lon": lon, "km": round(km, 2), "bearing": i, "raw_km": round(self.polar_max_km[i], 2)})
        return pts

    def summary(self) -> dict[str, Any]:
        nonzero = [k for k in self.polar_max_km if k > 0]
        cfg = store.load_config()
        return {
            "receiver": {
                "lat": cfg["lat"],
                "lon": cfg["lon"],
                "address": cfg.get("address") or "",
            },
            "stats": self.stats,
            "active_now": len(self.active),
            "sectors_hit": len(nonzero),
            "max_km": round(max(nonzero), 2) if nonzero else 0.0,
            "avg_max_km": round(sum(nonzero) / len(nonzero), 2) if nonzero else 0.0,
            "p50_km": round(sorted(nonzero)[len(nonzero) // 2], 2) if nonzero else 0.0,
            "outline": self.outline(),
            "raw_outline": self.raw_outline(),
            "smoothing": self.smoothing_params(),
            "first_contacts": self.first_contacts[-100:],
            "last_contacts": self.last_contacts[-100:],
            "polar_max_km": [round(x, 2) for x in self.polar_max_km],
        }


study = RangeStudy()


async def poll_loop() -> None:
    save_every = 0
    while True:
        try:
            cfg = store.load_config()
            base = cfg.get("adsb_url") or "http://ultrafeeder"
            async with httpx.AsyncClient(timeout=4.0) as client:
                r = await client.get(f"{base}/data/aircraft.json")
                if r.status_code == 200:
                    data = r.json()
                    aircraft = data.get("aircraft") or []
                    study.snapshot_aircraft(aircraft)
                    await aircraftdb.enrich(aircraft, base)  # matrícula/tipo no registro
                    try:
                        flightlog.ingest(aircraft, store.receiver())
                    except Exception as e:  # log não pode derrubar o estudo
                        print(f"flightlog: {e}", flush=True)
                    try:
                        from . import alerts
                        alerts.on_aircraft(aircraft)
                    except Exception as e:
                        print(f"alerts: {e}", flush=True)
                    save_every += 1
                    if save_every >= 15:  # ~30s
                        study.save()
                        save_every = 0
        except Exception:
            pass
        await asyncio.sleep(2.0)


def start_background() -> None:
    if study._task and not study._task.done():
        return
    study._task = asyncio.create_task(poll_loop())
