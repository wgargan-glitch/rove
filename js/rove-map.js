const STYLES = {
  liberty: "https://tiles.openfreemap.org/styles/liberty",
  dark: "https://tiles.openfreemap.org/styles/dark",
  positron: "https://tiles.openfreemap.org/styles/positron",
  fiord: "https://tiles.openfreemap.org/styles/fiord",
};

const US_BOUNDS = [[-170, 15], [-64, 72]];
const OSRM = "https://router.project-osrm.org";
const PHOTON = "https://photon.komoot.io/api/";

function parksToGeoJSON(parks) {
  return {
    type: "FeatureCollection",
    features: parks.map((p) => ({
      type: "Feature",
      properties: { ...p },
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
    })),
  };
}

function formatMiles(meters) {
  const miles = meters / 1609.344;
  if (miles < 0.1) return `${Math.round(meters * 3.28084)} ft`;
  return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
}

function formatDuration(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} hr ${m % 60} min`;
}

function modifierLabel(mod) {
  if (!mod || mod === "straight") return "";
  return mod.replace(/_/g, " ");
}

function stepText(step) {
  const man = step.maneuver || {};
  const type = man.type || "";
  const mod = modifierLabel(man.modifier);
  const name = step.name && step.name !== "-" ? step.name : "";
  const onto = name ? ` onto ${name}` : "";
  switch (type) {
    case "depart":
      return name ? `Head out on ${name}` : "Head out";
    case "arrive":
      return "Arrive at destination";
    case "turn":
      return `Turn ${mod || "ahead"}${onto}`;
    case "new name":
      return name ? `Continue on ${name}` : "Continue";
    case "continue":
      return `Continue ${mod}${onto}`.trim();
    case "merge":
      return `Merge ${mod}${onto}`.trim();
    case "on ramp":
      return `Take the ramp ${mod}${onto}`.trim();
    case "off ramp":
      return `Take the exit ${mod}${onto}`.trim();
    case "fork":
      return `Keep ${mod || "ahead"} at the fork${onto}`;
    case "end of road":
      return `At the end of the road, turn ${mod}${onto}`;
    case "roundabout":
    case "rotary":
      return `Enter the roundabout${onto}`;
    case "roundabout turn":
      return `Exit the roundabout ${mod}${onto}`;
    case "notification":
      return name || "Continue";
    default:
      return `${type.replace(/_/g, " ")}${mod ? ` ${mod}` : ""}${onto}`.trim();
  }
}

export class RoveMap {
  constructor(options = {}) {
    this.el = typeof options.container === "string"
      ? document.getElementById(options.container)
      : options.container;
    this.styleKey = options.style || "dark";
    this.parks = [];
    this.listings = options.listings || [];
    this.selected = null;
    this.listeners = {};
    this.route = null;
    this.map = new maplibregl.Map({
      container: this.el,
      style: STYLES[this.styleKey] || STYLES.dark,
      center: options.center || [-98.5, 39.8],
      zoom: options.zoom || 3.2,
      attributionControl: true,
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
    this.geo = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
    });
    this.map.addControl(this.geo, "bottom-right");
    this.originMarker = null;
    this.destMarker = null;
    this.map.on("load", () => {
      this.#drawParks();
      this.#drawListings();
      this.emit("ready", { parks: this.parks.length });
    });
  }

  on(event, fn) {
    (this.listeners[event] ||= []).push(fn);
    return this;
  }

  emit(event, payload) {
    (this.listeners[event] || []).forEach((fn) => fn(payload));
    if (window.parent !== window) {
      window.parent.postMessage({ source: "rove-map", event, payload }, "*");
    }
  }

  async loadParks(url = "data/us-national-parks.json") {
    const res = await fetch(url);
    const json = await res.json();
    this.parks = json.parks || json;
    if (this.map.isStyleLoaded()) this.#drawParks();
    this.emit("parks-loaded", this.parks);
    return this.parks;
  }

  setStyle(key) {
    this.styleKey = key;
    this.map.setStyle(STYLES[key] || STYLES.dark);
    this.map.once("styledata", () => {
      this.#drawParks();
      this.#drawListings();
      if (this.route) this.#drawRoute(this.route.geometry);
    });
  }

  focusPark(slug, zoom = 9.5) {
    const park = this.parks.find((p) => p.slug === slug);
    if (!park) return;
    this.selected = park.slug;
    this.map.flyTo({ center: [park.lng, park.lat], zoom, essential: true });
    this.#setDestMarker(park.lng, park.lat);
    this.emit("select", park);
  }

  parkBySlug(slug) {
    return this.parks.find((p) => p.slug === slug);
  }

  fitUSA() {
    this.map.fitBounds(US_BOUNDS, { padding: 48, duration: 900 });
  }

  setListings(listings) {
    this.listings = listings || [];
    this.#drawListings();
  }

  search(q) {
    const needle = q.trim().toLowerCase();
    if (!needle) return this.parks.slice();
    return this.parks.filter((p) =>
      [p.name, p.state, p.region, p.pickupTown, p.slug]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle))
    );
  }

  async geocode(query) {
    const url = `${PHOTON}?q=${encodeURIComponent(query)}&limit=6&lang=en`;
    const res = await fetch(url);
    const json = await res.json();
    return (json.features || []).map((f) => {
      const p = f.properties || {};
      const [lng, lat] = f.geometry.coordinates;
      const label = [p.name, p.city, p.state, p.country].filter(Boolean).join(", ");
      return { label, lng, lat, raw: p };
    });
  }

  async routeDrive(origin, dest) {
    const path = `${origin.lng},${origin.lat};${dest.lng},${dest.lat}`;
    const url = `${OSRM}/route/v1/driving/${path}?overview=full&geometries=geojson&steps=true&alternatives=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Routing service unavailable");
    const json = await res.json();
    if (json.code !== "Ok" || !json.routes?.length) {
      throw new Error(json.message || "No driving route found");
    }
    const primary = json.routes[0];
    const steps = [];
    for (const leg of primary.legs || []) {
      for (const step of leg.steps || []) {
        steps.push({
          instruction: stepText(step),
          distance: step.distance,
          duration: step.duration,
          name: step.name,
          type: step.maneuver?.type,
          modifier: step.maneuver?.modifier,
          location: step.maneuver?.location,
        });
      }
    }
    this.route = {
      geometry: primary.geometry,
      distance: primary.distance,
      duration: primary.duration,
      steps,
      alternatives: (json.routes || []).slice(1).map((r) => ({
        distance: r.distance,
        duration: r.duration,
      })),
    };
    this.#setOriginMarker(origin.lng, origin.lat);
    this.#setDestMarker(dest.lng, dest.lat);
    this.#drawRoute(primary.geometry);
    const coords = primary.geometry.coordinates;
    if (coords.length) {
      const bounds = coords.reduce(
        (b, c) => b.extend(c),
        new maplibregl.LngLatBounds(coords[0], coords[0]),
      );
      this.map.fitBounds(bounds, { padding: 72, duration: 800 });
    }
    this.emit("route", this.route);
    return this.route;
  }

  clearRoute() {
    this.route = null;
    if (this.map.getSource("rove-route")) {
      this.map.getSource("rove-route").setData({ type: "FeatureCollection", features: [] });
    }
    this.emit("route", null);
  }

  locate() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Location is not available"));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lng: pos.coords.longitude, lat: pos.coords.latitude }),
        () => reject(new Error("Could not read your location")),
        { enableHighAccuracy: true, timeout: 12000 },
      );
    });
  }

  #setOriginMarker(lng, lat) {
    if (!this.originMarker) {
      const el = document.createElement("div");
      el.className = "rove-pin rove-pin-origin";
      this.originMarker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(this.map);
    } else {
      this.originMarker.setLngLat([lng, lat]);
    }
  }

  #setDestMarker(lng, lat) {
    if (!this.destMarker) {
      const el = document.createElement("div");
      el.className = "rove-pin rove-pin-dest";
      this.destMarker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(this.map);
    } else {
      this.destMarker.setLngLat([lng, lat]);
    }
  }

  #drawRoute(geometry) {
    const data = { type: "Feature", properties: {}, geometry };
    if (this.map.getSource("rove-route")) {
      this.map.getSource("rove-route").setData(data);
      return;
    }
    if (!this.map.getStyle()) return;
    this.map.addSource("rove-route", { type: "geojson", data });
    this.map.addLayer({
      id: "rove-route-halo",
      type: "line",
      source: "rove-route",
      paint: { "line-color": "#0e1410", "line-width": 8, "line-opacity": 0.55 },
    });
    this.map.addLayer({
      id: "rove-route-line",
      type: "line",
      source: "rove-route",
      paint: { "line-color": "#e0a15a", "line-width": 4.5, "line-opacity": 0.95 },
    });
  }

  #drawParks() {
    if (!this.parks.length || !this.map.getStyle()) return;
    const src = "rove-parks";
    const data = parksToGeoJSON(this.parks);
    if (this.map.getSource(src)) {
      this.map.getSource(src).setData(data);
      return;
    }
    this.map.addSource(src, { type: "geojson", data });
    this.map.addLayer({
      id: "rove-parks-glow",
      type: "circle",
      source: src,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 6, 10, 16],
        "circle-color": "#c9e2b3",
        "circle-opacity": 0.18,
      },
    });
    this.map.addLayer({
      id: "rove-parks-dot",
      type: "circle",
      source: src,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 3.2, 10, 7],
        "circle-color": "#7ea36a",
        "circle-stroke-width": 1.4,
        "circle-stroke-color": "#f4ead4",
      },
    });
    this.map.addLayer({
      id: "rove-parks-label",
      type: "symbol",
      source: src,
      minzoom: 4.2,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 12,
        "text-offset": [0, 1.1],
        "text-anchor": "top",
      },
      paint: {
        "text-color": "#f4ead4",
        "text-halo-color": "#0e1410",
        "text-halo-width": 1.2,
      },
    });
    this.map.on("click", "rove-parks-dot", (e) => {
      const f = e.features[0];
      if (f?.properties?.slug) this.focusPark(f.properties.slug);
    });
    this.map.on("mouseenter", "rove-parks-dot", () => {
      this.map.getCanvas().style.cursor = "pointer";
    });
    this.map.on("mouseleave", "rove-parks-dot", () => {
      this.map.getCanvas().style.cursor = "";
    });
  }

  #drawListings() {
    if (!this.map.getStyle()) return;
    const src = "rove-listings";
    const data = {
      type: "FeatureCollection",
      features: this.listings.map((l) => ({
        type: "Feature",
        properties: l,
        geometry: { type: "Point", coordinates: [l.lng, l.lat] },
      })),
    };
    if (this.map.getSource(src)) {
      this.map.getSource(src).setData(data);
      return;
    }
    if (!this.listings.length) return;
    this.map.addSource(src, { type: "geojson", data });
    this.map.addLayer({
      id: "rove-listings-dot",
      type: "circle",
      source: src,
      paint: {
        "circle-radius": 5,
        "circle-color": "#e0a15a",
        "circle-stroke-width": 1.2,
        "circle-stroke-color": "#0e1410",
      },
    });
  }
}

window.RoveMap = RoveMap;
window.roveFormat = { miles: formatMiles, duration: formatDuration };
