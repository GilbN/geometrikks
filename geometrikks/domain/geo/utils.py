from geoalchemy2.functions import ST_SetSRID, ST_MakePoint

WGS84_SRID = 4326  # Standard GPS coordinate system

def make_point(latitude: float, longitude: float):
    "Create a PostGIS POINT from latitude and longitude."
    return ST_SetSRID(ST_MakePoint(longitude, latitude), WGS84_SRID)
