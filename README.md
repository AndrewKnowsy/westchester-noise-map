# Westchester Noise Map

Type a Westchester County address and see modeled transportation noise around the house:

- the noise level at the house (24-hour average, dBA)
- the range of levels across the tax parcel
- the levels from road, rail and aviation separately, and the loudest spot within 500 m of each
- how much of the area within 100 m, 250 m and 500 m falls in each noise band
- a colour overlay on a street or aerial map; click any spot for its reading

## Run it

It's a static page, but it has to be served over http(s), not opened as a file, so the browser can read the noise tiles. From this folder:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open <http://localhost:8765>.

## Data

| What | Source |
| --- | --- |
| Noise levels | US DOT Bureau of Transportation Statistics, National Transportation Noise Map. Default: 2022/2023 release (2022 aviation and rail, 2023 roads), served by BTS as `NTAD_Noise_2022_CONUS_*` tile services on `tiles.arcgis.com`. A toggle switches to the 2020 release (`geo.dot.gov`) for comparison. |
| Address search | Westchester County GIS address locator (address points and tax parcels) |
| Parcel outline | Westchester County GIS tax parcels |
| Base maps | Esri Light Gray Canvas and World Imagery |

BTS publishes the noise data as pre-rendered colour tiles, not raw numbers. The page reads each tile's pixel colour and matches it to the legend classes (45–50, 50–55, 55–60, 60–70, 70–80, 80–90, 90+ dB). A pixel is a cell about 30 m across, the finest zoom BTS caches. Readings are therefore bands, not exact decibel values.

The levels are modeled 24-hour equivalent A-weighted sound levels (24-hr LAeq, dBA), not measurements, and cover road, rail and aviation only. Anything under 45 dB is blank. BTS says the map was built for national trend-tracking and "should not be used to evaluate noise levels in individual locations". It ignores shielding from barriers and terrain, so shielded spots may be overestimated. Treat the readings as a screening view.

The 2022/2023 tile services don't publish a legend, but they use the same seven colours as 2020. A cell-by-cell comparison of road noise around White Plains found no systematic shift between the two years, so the page assumes the same class breaks. Exact decibel values would need the raw rasters from the BTS download page, which aren't used here.

## For developers

### What's here

Three static files (`index.html`, `style.css`, `app.js`). There's no build step, no backend and no API keys. Leaflet 1.9.4 loads from unpkg.

### How `app.js` is organised

- **Config at the top:** `DATASETS` (noise tile services for each data year), the Westchester County GIS endpoints, the county bounds, and `BANDS` (colour → dB class).
- **`bandAt(source, lat, lng)`:** the noise band at a point.
- **`cellsAround(source, lat, lng, radiusM)`:** every 30 m cell within a radius, with its band, distance and compass bearing.
- **`geocode(text, magicKey)`:** the county address locator, with an OpenStreetMap Nominatim fallback.
- **`fetchParcel(lat, lng)`:** the tax-parcel polygon containing a point.
- **`analyse(lat, lng, label)`:** runs the readings and renders the side panel.

`bandAt` and `cellsAround` are the reusable core. Use them to add a noise section to another page, such as a property report, without the map. They run in the browser. A server-side version would fetch the same zoom-12 PNG tiles and decode the pixels, for example with Pillow.

### Putting it on the Knowsy site

- **As a standalone page:** serve this folder as static files, then link to it or embed it in an `<iframe>`. In the Knowsy repo, `vercel.json` currently sends every route to `api/index.py`. Either add a static route ahead of that catch-all, or serve these files from the Python app.
- **Inside the property report:** reuse `bandAt` / `cellsAround` (or a server-side port) in `report_generator_app` to add noise readings to each report.

### Check before it goes public

| Dependency | Key needed today | What to check |
| --- | --- | --- |
| BTS noise tiles | No | Public domain. BTS asks for acknowledgment. Keep the screening-view caveat next to any reading. |
| Westchester County GIS locator and parcels | No | Public ArcGIS services with no published SLA. Confirm the county is fine with a commercial site calling them. |
| Esri basemap tiles | No | Check Esri's terms for commercial use. It may need an ArcGIS Location Platform account and key, or swap in any XYZ tile provider you already pay for. |
| Nominatim (search fallback only) | No | The public OSM server allows only light use (about 1 request per second). Remove the fallback or point it at a paid geocoder before launch. |
| Leaflet via unpkg | No | BSD-2 licence. Consider self-hosting. |

Other notes:

- If BTS renames or retires a tile service, update `DATASETS`.
- The noise data covers the lower 48 states. Only the address search limits the tool to Westchester; swap the geocoder to cover other counties.
