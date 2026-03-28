const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SERVER_SECRET = process.env.BACKEND_TOKEN;
const MODEL = 'claude-haiku-4-5-20251001';

// ── Auth middleware ──────────────────────────────────────────────────────────
// Rejects any request that doesn't include the correct Bearer token.
// This prevents the public from abusing your Anthropic API key.
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

// ── POST /api/insights ────────────────────────────────────────────────────────
// Generates 3 post-round coaching points based on hole scores.
// Called by the app after a round is marked is_complete = true.
//
// Request body:
//   holes: array of { holeNumber, par, score, putts, fairwayHit, gir, approachX, approachY, approachDist }
//   handicap: number (optional)
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

  // Build approach miss summary
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
// Generates a single pre-hole tip based on the hole layout and the golfer's miss pattern.
// Called when a Pro user loads each hole. Kept short to minimise latency.
//
// Request body:
//   holeNumber: number
//   par: number
//   yards: number
//   hazards: array of { type, label }
//   missPattern: string (e.g. "63% of approaches short-left")
//   handicap: number (optional)
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
// Generates a 5-round trend summary for the Season Stats screen.
//
// Request body:
//   rounds: array of { playedAt, score, par, girCount, fwCount, avgPutts, approachSummary }
//   handicap: number (optional)
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
  console.log(`SERVER_SECRET set: ${!!process.env.SERVER_SECRET}`);
});
