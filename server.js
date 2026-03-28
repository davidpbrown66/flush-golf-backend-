const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SERVER_SECRET = process.env.BACKEND_TOKEN;
const GOLFCOURSE_API_KEY = process.env.GOLFCOURSE_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';

// ── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${SERVER_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  next();
}

app.use(requireAuth);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── GET /api/courses/search ───────────────────────────────────────────────────
// Searches GolfCourseAPI for courses matching the query string.
// Returns a list of courses with id, name, location.
// The iOS app uses this to let the user pick their course before a round.
//
// Query params:
//   q: string — course or club name to search
app.get('/api/courses/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'q parameter required (min 2 chars)' });
  }

  try {
    const response = await fetch(
      `https://api.golfcourseapi.com/v1/search?search_query=${encodeURIComponent(q.trim())}`,
      { headers: { 'Authorization': `Key ${GOLFCOURSE_API_KEY}` } }
    );

    if (!response.ok) {
      console.error('GolfCourseAPI search error:', response.status);
      return res.status(502).json({ error: 'Course search failed' });
    }

    const data = await response.json();

    // Return a trimmed list — just what the iOS picker needs
    const courses = (data.courses || []).map(c => ({
      id:         c.id,
      clubName:   c.club_name,
      courseName: c.course_name,
      location: {
        address:   c.location?.address,
        city:      c.location?.city,
        state:     c.location?.state,
        country:   c.location?.country,
        latitude:  c.location?.latitude,
        longitude: c.location?.longitude,
      }
    }));

    res.json({ courses });
  } catch (err) {
    console.error('/api/courses/search error:', err.message);
    res.status(500).json({ error: 'Course search failed' });
  }
});

// ── GET /api/courses/:id/holes ─────────────────────────────────────────────────
// Returns full hole data for a course:
//   - Par, yards, stroke index from GolfCourseAPI
//   - Green polygon, front/centre/back coords, hazards from OpenStreetMap
//
// The iOS app caches this in Supabase after the first fetch.
// During a live round, the app reads from Supabase only — this endpoint
// is never called mid-round.
app.get('/api/courses/:id/holes', async (req, res) => {
  const courseId = parseInt(req.params.id, 10);
  if (isNaN(courseId)) {
    return res.status(400).json({ error: 'Invalid course id' });
  }

  try {
    // ── Step 1: GolfCourseAPI — metadata ──────────────────────────────────────
    const gcaRes = await fetch(
      `https://api.golfcourseapi.com/v1/courses/${courseId}`,
      { headers: { 'Authorization': `Key ${GOLFCOURSE_API_KEY}` } }
    );

    if (!gcaRes.ok) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const courseData = await gcaRes.json();
    const lat = courseData.location?.latitude;
    const lng = courseData.location?.longitude;

    // Pick the first male tee set that has 18 holes, or just the first one
    const tees = courseData.tees?.male || [];
    const teeset = tees.find(t => t.number_of_holes === 18) || tees[0];
    const gcaHoles = teeset?.holes || [];

    // ── Step 2: OpenStreetMap — geometry ──────────────────────────────────────
    let osmHoles = {};
    if (lat && lng) {
      osmHoles = await fetchOSMHoles(lat, lng);
    }

    // ── Step 3: Merge ─────────────────────────────────────────────────────────
    const holes = [];
    for (let i = 0; i < Math.max(gcaHoles.length, 18); i++) {
      const holeNumber = i + 1;
      const gca  = gcaHoles[i] || {};
      const osm  = osmHoles[holeNumber] || {};

      // Derive front/centre/back from green polygon if we have one
      let frontLat = null, frontLng = null;
      let centerLat = null, centerLng = null;
      let backLat = null, backLng = null;

      if (osm.greenPolygon && osm.greenPolygon.length >= 3) {
        const c = centroid(osm.greenPolygon);
        centerLat = c.lat;
        centerLng = c.lng;
        const fb = frontBack(osm.greenPolygon);
        frontLat = fb.front.lat;
        frontLng = fb.front.lng;
        backLat  = fb.back.lat;
        backLng  = fb.back.lng;
      }

      holes.push({
        holeNumber,
        par:          gca.par         ?? null,
        yards:        gca.yardage     ?? null,
        strokeIndex:  gca.handicap    ?? null,   // GolfCourseAPI calls it "handicap"
        greenPolygon: osm.greenPolygon ?? [],
        frontLat, frontLng,
        centerLat, centerLng,
        backLat, backLng,
        teeLat:  osm.teeLat  ?? null,
        teeLng:  osm.teeLng  ?? null,
        hazards: osm.hazards ?? [],
      });
    }

    res.json({
      id:         courseData.id,
      clubName:   courseData.club_name,
      courseName: courseData.course_name,
      latitude:   lat,
      longitude:  lng,
      par:        teeset?.par_total ?? null,
      holes,
    });

  } catch (err) {
    console.error('/api/courses/:id/holes error:', err.message);
    res.status(500).json({ error: 'Failed to fetch course holes' });
  }
});

// ── OSM helpers ───────────────────────────────────────────────────────────────

// Fetches golf features from OpenStreetMap Overpass API near the given coordinates.
// Returns a map of holeNumber → { greenPolygon, teeLat, teeLng, hazards }
async function fetchOSMHoles(lat, lng) {
  const query = `
    [out:json][timeout:30];
    (
      way["golf"="green"](around:1000,${lat},${lng});
      way["golf"="tee"](around:1000,${lat},${lng});
      way["golf"="bunker"](around:1000,${lat},${lng});
      way["golf"="water_hazard"](around:1000,${lat},${lng});
      way["golf"="lateral_water_hazard"](around:1000,${lat},${lng});
    );
    out geom;
  `;

  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body:   query,
      headers: { 'Content-Type': 'text/plain' }
    });

    if (!response.ok) {
      console.warn('OSM Overpass returned', response.status);
      return {};
    }

    const data = await response.json();
    return parseOSMWays(data.elements || []);
  } catch (err) {
    console.warn('OSM fetch failed (non-fatal):', err.message);
    return {};
  }
}

// Parses OSM way elements into a holeNumber-keyed map.
// OSM tags golf holes with `ref` (e.g. ref=7 means hole 7).
function parseOSMWays(elements) {
  const holes = {};

  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry) continue;

    const tags     = el.tags || {};
    const golfType = tags['golf'];
    const ref      = parseInt(tags['ref'] || tags['golf:hole'] || '0', 10);
    const holeNum  = (ref >= 1 && ref <= 18) ? ref : null;

    // Convert OSM geometry nodes to {lat, lng} pairs
    const coords = el.geometry.map(n => ({ lat: n.lat, lng: n.lon }));
    if (coords.length < 3) continue;

    if (golfType === 'green' && holeNum) {
      if (!holes[holeNum]) holes[holeNum] = { hazards: [] };
      holes[holeNum].greenPolygon = coords;
    }

    if (golfType === 'tee' && holeNum) {
      if (!holes[holeNum]) holes[holeNum] = { hazards: [] };
      const c = centroid(coords);
      holes[holeNum].teeLat = c.lat;
      holes[holeNum].teeLng = c.lng;
    }

    if ((golfType === 'bunker' || golfType === 'water_hazard' || golfType === 'lateral_water_hazard') && holeNum) {
      if (!holes[holeNum]) holes[holeNum] = { hazards: [] };
      holes[holeNum].hazards.push({ type: golfType, polygon: coords });
    }
  }

  return holes;
}

// Returns the centroid (average lat/lng) of a polygon.
function centroid(coords) {
  const lat = coords.reduce((s, c) => s + c.lat, 0) / coords.length;
  const lng = coords.reduce((s, c) => s + c.lng, 0) / coords.length;
  return { lat, lng };
}

// Returns the front (southernmost) and back (northernmost) points of a polygon.
// Assumes the hole plays roughly north — good enough for v1.
function frontBack(coords) {
  const sorted = [...coords].sort((a, b) => a.lat - b.lat);
  return { front: sorted[0], back: sorted[sorted.length - 1] };
}

// ── POST /api/insights ────────────────────────────────────────────────────────
app.post('/api/insights', async (req, res) => {
  const { holes, handicap } = req.body;
  if (!holes || !Array.isArray(holes)) {
    return res.status(400).json({ error: 'holes array required' });
  }

  const totalScore = holes.reduce((sum, h) => sum + (h.score || 0), 0);
  const totalPar   = holes.reduce((sum, h) => sum + (h.par  || 4), 0);
  const scoreToPar = totalScore - totalPar;
  const girCount   = holes.filter(h => h.gir).length;
  const fwCount    = holes.filter(h => h.fairwayHit).length;
  const avgPutts   = (holes.reduce((sum, h) => sum + (h.putts || 0), 0) / holes.length).toFixed(1);

  const approachHoles = holes.filter(h => h.approachX != null && h.approachY != null);
  let approachSummary = 'No approach data recorded.';
  if (approachHoles.length > 0) {
    const leftMisses  = approachHoles.filter(h => h.approachX < -0.25).length;
    const rightMisses = approachHoles.filter(h => h.approachX >  0.25).length;
    const shortMisses = approachHoles.filter(h => h.approachY < -0.25).length;
    const longMisses  = approachHoles.filter(h => h.approachY >  0.25).length;
    approachSummary = `${approachHoles.length} approaches recorded. Left: ${leftMisses}, Right: ${rightMisses}, Short: ${shortMisses}, Long: ${longMisses}.`;
  }

  const prompt = `You are an expert golf coach. A golfer just completed a round. Give them exactly 3 concise, specific coaching insights based on their stats. Each insight should be 1-2 sentences. Be encouraging but honest. Focus on the most impactful improvement areas.

Round stats:
- Score: ${totalScore} (${scoreToPar >= 0 ? '+' : ''}${scoreToPar} to par)
- Handicap: ${handicap || 'unknown'}
- Greens in Regulation: ${girCount}/18
- Fairways Hit: ${fwCount}/${holes.filter(h => h.par > 3).length}
- Average Putts: ${avgPutts}
- Approach shots: ${approachSummary}

Respond with exactly 3 insights, each on a new line, numbered 1. 2. 3. No headers or extra formatting.`;

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }]
    });
    res.json({ insight: message.content[0].text });
  } catch (err) {
    console.error('/api/insights error:', err.message);
    res.status(500).json({ error: 'Failed to generate insight' });
  }
});

// ── POST /api/hole-strategy ───────────────────────────────────────────────────
app.post('/api/hole-strategy', async (req, res) => {
  const { holeNumber, par, yards, hazards, missPattern, handicap } = req.body;

  const hazardText = hazards && hazards.length > 0
    ? hazards.map(h => `${h.type}${h.label ? ' (' + h.label + ')' : ''}`).join(', ')
    : 'no major hazards';

  const prompt = `You are a caddie giving a quick pre-shot tip. Be concise — one sentence only.

Hole ${holeNumber}: Par ${par}, ${yards || '?'} yards. Hazards: ${hazardText}. Golfer's miss pattern: ${missPattern || 'no data yet'}. Handicap: ${handicap || 'unknown'}.

Give one specific, actionable tip for this hole.`;

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }]
    });
    res.json({ tip: message.content[0].text });
  } catch (err) {
    console.error('/api/hole-strategy error:', err.message);
    res.status(500).json({ error: 'Failed to generate tip' });
  }
});

// ── POST /api/season-review ───────────────────────────────────────────────────
app.post('/api/season-review', async (req, res) => {
  const { rounds, handicap } = req.body;
  if (!rounds || !Array.isArray(rounds)) {
    return res.status(400).json({ error: 'rounds array required' });
  }

  const roundSummaries = rounds.map((r, i) =>
    `Round ${i + 1}: Score ${r.score} (${r.score - r.par >= 0 ? '+' : ''}${r.score - r.par}), GIR ${r.girCount}/18, Putts avg ${r.avgPutts}. ${r.approachSummary || ''}`
  ).join('\n');

  const prompt = `You are an expert golf coach reviewing a golfer's last ${rounds.length} rounds. Give a season review with exactly 5 insights covering trends, improvements, and areas to work on. Each insight is 1-2 sentences. Be specific and data-driven.

Golfer handicap: ${handicap || 'unknown'}

Recent rounds:
${roundSummaries}

Respond with exactly 5 insights, numbered 1-5, each on a new line. No headers.`;

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    });
    res.json({ review: message.content[0].text });
  } catch (err) {
    console.error('/api/season-review error:', err.message);
    res.status(500).json({ error: 'Failed to generate review' });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Flush Golf backend running on port ${PORT}`);
  console.log(`BACKEND_TOKEN set: ${!!process.env.BACKEND_TOKEN}`);
  console.log(`GOLFCOURSE_API_KEY set: ${!!process.env.GOLFCOURSE_API_KEY}`);
});
