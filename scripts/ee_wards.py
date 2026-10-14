"""Per-ward statistics from Google Earth Engine, written to data/raw/ee-wards.json.

Run with the project venv after `ee.Authenticate()` has been done once:
    .venv/bin/python scripts/ee_wards.py
scripts/build-data.mjs merges the result when the file exists.

  heat      Landsat 8/9 Collection 2 surface temperature, 30 m, ~10:30 am, cloud-masked
            median over peak summer
  greenery  Sentinel-2 NDVI, 10 m, cloud-filtered median over the dry season
  trees     ESA WorldCover 2021, 10 m: share of the ward under tree canopy. (Dynamic World and
            Esri 10 m land cover were tried too: both read near 0% trees in leafy wards such as
            Malleswaram, while WorldCover tracks the Sentinel-2 greenery index, r = 0.92.)
  built     Dynamic World land cover, 10 m: where the usual class is "built", for the wetlands
  people    GHSL 2025 population grid (JRC, 100 m), summed per ward. WorldPop 2020 was tried and
            counts 8.3 M in the wards, below the 2011 census; GHSL counts 13.4 M.
  light     VIIRS night-time lights, annual average radiance (nW/cm²/sr), outliers masked
  lowland   MERIT Hydro height above nearest drainage, 90 m: share of the ward less than
            LOWLAND_M above the drainage line it would flood from
  wetlands  JRC Global Surface Water 1984–2021 (Landsat, 30 m): water and wetland that has since
            disappeared, split by today's Dynamic World class into "built over" and "dried out or
            choked by weeds", plus water that is still there. Shares per ward, and the outlines
            themselves in data/raw/ee-wetlands.geojson
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
POPULATION_YEAR = 2025
LIGHT_YEAR = '2025'
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
built = cover.eq(6).rename('built')
trees = ee.ImageCollection('ESA/WorldCover/v200').first().eq(10).rename('trees')
people = ee.Image(f'JRC/GHSL/P2023A/GHS_POP/{POPULATION_YEAR}').rename('people')
light = (
    ee.ImageCollection('NOAA/VIIRS/DNB/ANNUAL_V22')
    .filterDate(f'{LIGHT_YEAR}-01-01', f'{int(LIGHT_YEAR) + 1}-01-01')
    .first()
    .select('average_masked')
    .rename('light')
)

lowland = ee.Image('MERIT/Hydro/v1_0_1').select('hnd').lt(LOWLAND_M).rename('lowland')


# Transition classes: 3 lost permanent, 6 lost seasonal; 1, 2, 4, 5, 7, 8 still water (8 has
# shrunk from permanent to seasonal). 9 and 10 are short-lived water inside the record, mostly
# flooding and construction pits, so they are left out.
transition = ee.Image('JRC/GSW1_4/GlobalSurfaceWater').select('transition')
lost = transition.eq(3).Or(transition.eq(6))
still = transition.remap([1, 2, 4, 5, 7, 8], [1, 1, 1, 1, 1, 1], 0)
WETLAND_CLASS = {1: 'built', 2: 'dried', 3: 'water'}
wetland = (
    lost.And(built).multiply(1)
    .add(lost.And(built.Not()).multiply(2))
    .add(still.multiply(3))
    .rename('wetland')
)
wetland_shares = (
    lost.And(built).rename('wetland_built')
    .addBands(lost.And(built.Not()).rename('wetland_dried'))
    .addBands(still.rename('wetland_water'))
)


def per_ward(image, scale, reducer=ee.Reducer.mean()):
    rows = image.reduceRegions(wards, reducer, scale).select(['.*'], None, False).getInfo()
    # A one-band image comes back under the reducer's name instead of its band name.
    band = image.bandNames().getInfo()[0]
    result = {}
    for f in rows['features']:
        props = dict(f['properties'])
        for name in ('mean', 'sum'):
            if name in props:
                props[band] = props.pop(name)
        result[props['id']] = props
    return result


out = {f['properties']['id']: {} for f in wards_json['features']}
for name, image, scale, reducer in [
    ('heat', heat, 30, ee.Reducer.mean()),
    ('greenery', greenery, 10, ee.Reducer.mean()),
    ('tree cover', trees, 10, ee.Reducer.mean()),
    ('lowland', lowland, 30, ee.Reducer.mean()),
    ('wetlands', wetland_shares.unmask(0), 30, ee.Reducer.mean()),
    ('people', people, 100, ee.Reducer.sum()),
    ('night light', light, 100, ee.Reducer.mean()),
]:
    print(f'{name} …', flush=True)
    for ward_id, props in per_ward(image, scale, reducer).items():
        out[ward_id].update({k: v for k, v in props.items() if k != 'id'})

print('wetland outlines …', flush=True)
outlines = (
    wetland.selfMask()
    .reduceToVectors(
        geometry=city, scale=30, geometryType='polygon', eightConnected=True, labelProperty='cls', maxPixels=1e9
    )
    .getInfo()
)
(ROOT / 'data/raw/ee-wetlands.geojson').write_text(
    json.dumps(
        {
            'type': 'FeatureCollection',
            'features': [
                {'type': 'Feature', 'properties': {'kind': WETLAND_CLASS[f['properties']['cls']]}, 'geometry': f['geometry']}
                for f in outlines['features']
            ],
        }
    )
)

meta = {
    'landsat_scenes': landsat.size().getInfo(),
    'sentinel2_scenes': s2.size().getInfo(),
    'summer': SUMMER,
    'dry_season': DRY,
    'land_cover': LAND_COVER,
    'lowland_m': LOWLAND_M,
    'surface_water': 'JRC/GSW1_4 1984-2021',
    'population_year': POPULATION_YEAR,
    'light_year': LIGHT_YEAR,
}
(ROOT / 'data/raw/ee-wards.json').write_text(json.dumps({'meta': meta, 'wards': out}))
print(meta)
