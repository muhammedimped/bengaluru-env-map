"""Night-lights image for the map's "Night lights" view, written to public/data/nightlights.png.

    .venv/bin/python scripts/ee_nightlights.py

VIIRS annual average radiance (nW/cm²/sr, outliers masked), about 460 m per pixel, on a log
scale so dim suburbs still show next to the brightest commercial streets. The map stretches
the image over BOUNDS (west, south, east, north) in src/App.tsx; keep the two in step.
"""
import urllib.request
import pathlib
import warnings

warnings.simplefilter('ignore')
import ee  # noqa: E402

PROJECT = 'bengaluru-environment-map'
ROOT = pathlib.Path(__file__).resolve().parent.parent
YEAR = 2025
BOUNDS = (77.3, 12.7, 77.95, 13.3)

ee.Initialize(project=PROJECT)
region = ee.Geometry.Rectangle(list(BOUNDS), 'EPSG:4326', False)
light = (
    ee.ImageCollection('NOAA/VIIRS/DNB/ANNUAL_V22')
    .filterDate(f'{YEAR}-01-01', f'{YEAR + 1}-01-01')
    .first()
    .select('average_masked')
    .unmask(0)
    # Smooth between the ~460 m pixels instead of drawing them as blocks.
    .resample('bicubic')
)
glow = light.max(1).log10()  # 2 nW → 0.3 (black), 110 nW → 2.05 (white); the city spans ~1.5–80
url = glow.getThumbURL(
    {
        'region': region,
        'crs': 'EPSG:4326',
        'dimensions': '640x591',  # ~1 px per 100 m; the map smooths the 460 m pixels
        'min': 0.3,
        'max': 2.05,
        'palette': ['000000', '1a0b2e', '5a1d4f', 'b5452a', 'f08c2a', 'ffd36b', 'fff6d8'],
        'format': 'png',
    }
)
out = ROOT / 'public/data/nightlights.png'
urllib.request.urlretrieve(url, out)
print(out, out.stat().st_size // 1024, 'KB')
