# Rove Map

Standalone map for **Rove**. No Google, no Apple, no Mapbox bill.

US national parks are loaded now. The basemap is already worldwide (OpenStreetMap via OpenFreeMap). Add Canada / Europe / LatAm / ANZ overlays the same way when those catalogs go live.

## Open it

Serve the folder. Opening `index.html` as a file will fail because the park JSON is fetched.

```bash
cd rove-map
python3 -m http.server 8787
```

Then open `http://localhost:8787`.

`embed.html` is a parent-page demo of the iframe API.

## What you get

- MapLibre GL + OpenFreeMap vector tiles (Liberty / Dark / Fiord)
- All 63 U.S. national parks, slugs aligned with Lookout (`yosemite`, `grand-canyon`, …)
- Search by park, state, region, gateway town
- Night / day styles
- Hash URLs (`#zion`)
- postMessage API for Rove / Lookout

Park coordinates come from public NPS centroids (NOAA NIDIS extract of NPS points) plus New River Gorge. Public domain.

## Drop into Rove

```html
<iframe src="https://YOUR_HOST/rove-map/" id="rove-map" title="Rove Map"></iframe>
```

```js
const frame = document.getElementById("rove-map");

frame.contentWindow.postMessage({
  target: "rove-map",
  action: "focus",
  slug: "yosemite"
}, "*");

frame.contentWindow.postMessage({
  target: "rove-map",
  action: "listings",
  listings: [
    { id: "bronco-yosemite", title: "Bronco", lng: -119.67, lat: 37.67 }
  ]
}, "*");

window.addEventListener("message", (event) => {
  if (event.data?.source !== "rove-map") return;
  if (event.data.event === "select") {
    const park = event.data.payload;
    // route to /parks/yosemite etc.
  }
});
```

In Lookout you can also import `js/rove-map.js` and mount it on a div instead of an iframe.

## Worldwide later

1. Keep this basemap. It already covers the planet.
2. Add `data/canada-parks.json`, `data/europe-parks.json`, … with the same shape:

```json
{ "slug": "banff", "name": "Banff", "state": "Alberta", "region": "Rockies", "pickupTown": "Banff, AB", "lng": -115.57, "lat": 51.18 }
```

3. Call `rove.loadParks("data/canada-parks.json")` or merge arrays before `parksToGeoJSON`.

Do **not** point the map at `tile.openstreetmap.org` for production. OpenFreeMap is the public instance used here. If Rove traffic gets large, self-host OpenFreeMap or a Protomaps PMTiles extract on R2.

## Attribution

Required on every view (MapLibre adds it automatically):

OpenFreeMap © OpenMapTiles · Data from OpenStreetMap

Not affiliated with the National Park Service.
