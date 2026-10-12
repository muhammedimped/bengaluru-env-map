"""Per-ward statistics from Google Earth Engine, written to data/raw/ee-wards.json.

Run with the project venv after `ee.Authenticate()` has been done once:
    .venv/bin/python scripts/ee_wards.py
scripts/build-data.mjs merges the result when the file exists.

  heat      Landsat 8/9 Collection 2 surface temperature, 30 m, ~10:30 am, cloud-masked
            median over peak summer
  greenery  Sentinel-2 NDVI, 10 m, cloud-filtered median over the dry season
  trees     Dynamic World land cover, 10 m: share of the ward whose usual class is "trees",
            and share that is "built"
  lowland   MERIT Hydro height above nearest drainage, 90 m: share of the ward less than
            LOWLAND_M above the drainage line it would flood from
"""
import json
import pathlib
import warnings

warnings.simplefilter('ignore')
import ee  # noqa: E402

PROJECT = 'bengaluru-environment-map'
ROOT = pathlib.Path(__file__).resolve().parent.parent
SUMMER = ('2026-03-01', '2026-05-15')
DRY = ('2026-01-15', '2026-04-15')
LAND_COVER = ('2025-10-01', '2026-10-01')
LOWLAND_M = 3

ee.Initialize(project=PROJECT)

wards_json = json.loads((ROOT / 'public/data/wards.geojson').read_text())
wards = ee.FeatureCollection(
    [ee.Feature(ee.Geometry(f['geometry']), {'id': f['properties']['id']}) for f in wards_json['features']]
)
city = wards.geometry().bounds()


def landsat_celsius(img):
    qa = img.select('QA_PIXEL')
    clear = qa.bitwiseAnd(1 << 3).eq(0).And(qa.bitwiseAnd(1 << 4).eq(0)).And(qa.bitwiseAnd(1 << 1).eq(0))
    return img.select('ST_B10').multiply(0.00341802).add(149.0).subtract(273.15).updateMask(clear).rename('lst')


landsat = (
    ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
    .merge(ee.ImageCollection('LANDSAT/LC09/C02/T1_L2'))
    .filterBounds(city)
    .filterDate(*SUMMER)
)
heat = landsat.map(landsat_celsius).median()

s2 = (
    ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(city)
    .filterDate(*DRY)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 15))
)
greenery = s2.map(lambda i: i.normalizedDifference(['B8', 'B4']).rename('ndvi')).median()

cover = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1').filterBounds(city).filterDate(*LAND_COVER).select('label').mode()
trees = cover.eq(1).rename('trees')
built = cover.eq(6).rename('built')

lowland = ee.Image('MERIT/Hydro/v1_0_1').select('hnd').lt(LOWLAND_M).rename('lowland')


def per_ward(image, scale):
    rows = image.reduceRegions(wards, ee.Reducer.mean(), scale).select(['.*'], None, False).getInfo()
    # A one-band image comes back as "mean" instead of under its band name.
    band = image.bandNames().getInfo()[0]
    result = {}
    for f in rows['features']:
        props = dict(f['properties'])
        if 'mean' in props:
            props[band] = props.pop('mean')
        result[props['id']] = props
    return result


out = {f['properties']['id']: {} for f in wards_json['features']}
for name, image, scale in [
    ('heat', heat, 30),
    ('greenery', greenery, 10),
    ('land cover', trees.addBands(built), 10),
    ('lowland', lowland, 30),
]:
    print(f'{name} …', flush=True)
    for ward_id, props in per_ward(image, scale).items():
        out[ward_id].update({k: v for k, v in props.items() if k != 'id'})

meta = {
    'landsat_scenes': landsat.size().getInfo(),
    'sentinel2_scenes': s2.size().getInfo(),
    'summer': SUMMER,
    'dry_season': DRY,
    'land_cover': LAND_COVER,
    'lowland_m': LOWLAND_M,
}
(ROOT / 'data/raw/ee-wards.json').write_text(json.dumps({'meta': meta, 'wards': out}))
print(meta)
