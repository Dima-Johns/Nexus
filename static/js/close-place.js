const NEAR_M = 80;

function inUz(lat, lng) {
  return lat > 37 && lat < 46 && lng > 55 && lng < 76;
}

function kmBetween(a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function closeCoords(o) {
  const lat = Number(o?.proof_lat);
  const lng = Number(o?.proof_lng);
  return inUz(lat, lng) ? [lat, lng] : null;
}

export function closeMeters(o) {
  const close = closeCoords(o);
  const lat = Number(o?.dropoff_lat);
  const lng = Number(o?.dropoff_lng);
  if (!close || !inUz(lat, lng)) return null;
  return kmBetween([lat, lng], close) * 1000;
}

export function closePhrase(o) {
  const close = closeCoords(o);
  if (!close) return "";
  const meters = closeMeters(o);
  if (meters == null) return "Yopilgan joy";
  if (meters <= NEAR_M) return "Do‘kon oldida yopilgan";
  if (meters < 1000) return `Do‘kondan ${Math.round(meters)} m narida yopilgan`;
  const km = meters / 1000;
  const text = km < 10 ? km.toFixed(1) : String(Math.round(km));
  return `Do‘kondan ${text} km narida yopilgan`;
}
