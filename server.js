// Simple Express backend for bug storage with file persistence
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
dotenv.config();
// Auth helpers (moved near top)
const JWT_SECRET = process.env.APP_JWT_SECRET || 'dev-insecure-secret';
const EXPECT_USER = process.env.APP_USERNAME
const EXPECT_PASS = process.env.APP_PASSWORD
function authAllowedPath(req){
  if (req.method === 'OPTIONS') return true;
  return req.path === '/api/login' || req.path === '/api/health';
}
function authMiddleware(req, res, next) {
  if (authAllowedPath(req)) return next();
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized' });
  try { jwt.verify(auth.substring(7), JWT_SECRET); return next(); } catch { return res.status(401).json({ error: 'unauthorized' }); }
}

// Create Express app
const app = express();
// Change default port to 5001 to match frontend default API_BASE
const PORT = process.env.PORT || 5001;

// Supabase client setup
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[FATAL] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing. Set env vars.');
}
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;

// Warn if auth env vars missing
if (!EXPECT_USER || !EXPECT_PASS) {
  console.warn('[WARN] APP_USERNAME or APP_PASSWORD not set. Login will always fail unless provided.');
} else {
  console.log(`[INFO] Auth credentials loaded for user: ${EXPECT_USER}`);
}

// Middleware
app.use(cors()); // reflect requesting origin
app.use(express.json());
// Request logging for debugging 403 issues
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});
// Simple health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Login route (public)
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === EXPECT_USER && password === EXPECT_PASS) {
    const token = jwt.sign({ u: username }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ token, expiresIn: 8 * 3600 });
  }
  return res.status(401).json({ error: 'invalid credentials' });
});
// Apply auth for all subsequent /api routes (excluding above)
app.use('/api', authMiddleware);

// Bug storage functions
const ALLOWED_LABELS = [
  'Betaalopdrachten',
  'Betaalverzoeken Parro',
  'Betaalverzoeken Email',
  'TSO',
  'Accounts / login',
  'Beheer & Instellingen'
];

// Replace in-memory/file operations with Supabase queries
async function listBugs() {
  if (!supabase) return [];
  const { data, error } = await supabase.from('bugs').select('*').order('createdAt', { ascending: true });
  if (error) { console.error('Supabase list error', error); return []; }
  return data || [];
}
async function getBug(id) {
  if (!supabase) return null;
  const { data, error } = await supabase.from('bugs').select('*').eq('id', id).single();
  if (error) { if (error.code !== 'PGRST116') console.error('Supabase get error', error); return null; }
  return data || null;
}
async function createBug(payload) {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase.from('bugs').insert([payload]).select().single();
  if (error) { console.error('Supabase insert error', error); throw error; }
  return data;
}
async function updateBug(id, changes) {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase.from('bugs').update(changes).eq('id', id).select().single();
  if (error) { console.error('Supabase update error', error); throw error; }
  return data;
}
async function deleteBug(id) {
  if (!supabase) throw new Error('Supabase not configured');
  const { error } = await supabase.from('bugs').delete().eq('id', id);
  if (error) { console.error('Supabase delete error', error); throw error; }
}
async function deleteAllNonReference() {
  if (!supabase) throw new Error('Supabase not configured');
  const { error } = await supabase.from('bugs').delete().eq('reference', false);
  if (error) { console.error('Supabase bulk delete error', error); throw error; }
}

// List all bugs
app.get('/api/bugs', async (req, res) => {
  const bugs = await listBugs();
  res.json(bugs);
});

// Create new bug
app.post('/api/bugs', async (req, res) => {
  const { ticket, description, jiraLink, impact, likelihood, label, reference } = req.body || {};
  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'description required' });
  }
  if (label && !ALLOWED_LABELS.includes(label)) {
    return res.status(400).json({ error: 'invalid label' });
  }
  const id = crypto.randomUUID();
  const trimmedTicket = typeof ticket === 'string' ? ticket.trim() : '';
  const newBug = {
    id,
    ticket: trimmedTicket || null,
    description: description.trim(),
    jiraLink: jiraLink || null,
    impact: Number(impact) || 1,
    likelihood: Number(likelihood) || 1,
    label: label ? label : null,
    completedAt: null,
    createdAt: Date.now(),
    reference: !!reference
  };
  try {
    const inserted = await createBug(newBug);
    res.status(201).json(inserted);
  } catch (e) {
    res.status(500).json({ error: 'insert failed' });
  }
});

// Get single bug
app.get('/api/bugs/:id', async (req, res) => {
  const bug = await getBug(req.params.id);
  if (!bug) return res.status(404).json({ error: 'bug not found' });
  res.json(bug);
});

// Update bug
app.put('/api/bugs/:id', async (req, res) => {
  const { id } = req.params;
  if (req.body.label && !ALLOWED_LABELS.includes(req.body.label)) {
    return res.status(400).json({ error: 'invalid label' });
  }
  if (req.body.completedAt !== undefined && req.body.completedAt !== null && typeof req.body.completedAt !== 'number') {
    return res.status(400).json({ error: 'invalid completedAt' });
  }
  const existing = await getBug(id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const incomingTicket = typeof req.body.ticket === 'string' ? req.body.ticket.trim() : (existing.ticket || '');
  const updated = {
    ticket: incomingTicket || null,
    description: req.body.description ? req.body.description.trim() : existing.description,
    jiraLink: req.body.jiraLink !== undefined ? (req.body.jiraLink || null) : existing.jiraLink,
    impact: req.body.impact !== undefined ? Number(req.body.impact) : existing.impact,
    likelihood: req.body.likelihood !== undefined ? Number(req.body.likelihood) : existing.likelihood,
    label: req.body.label !== undefined ? (req.body.label || null) : existing.label,
    reference: req.body.reference !== undefined ? !!req.body.reference : !!existing.reference,
    completedAt: req.body.completedAt !== undefined ? req.body.completedAt : existing.completedAt
  };
  try {
    const result = await updateBug(id, updated);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'update failed' });
  }
});

// Route to mark bug as completed
app.post('/api/bugs/:id/complete', async (req, res) => {
  const { id } = req.params;
  const bug = await getBug(id);
  if (!bug) return res.status(404).json({ error: 'bug not found' });
  if (bug.reference) return res.status(403).json({ error: 'reference bug cannot be completed' });
  if (bug.completedAt) return res.status(409).json({ error: 'already completed' });
  try {
    const result = await updateBug(id, { completedAt: Date.now() });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'complete failed' });
  }
});

// Delete single bug
app.delete('/api/bugs/:id', async (req, res) => {
  const { id } = req.params;
  const bug = await getBug(id);
  if (!bug) return res.status(404).json({ error: 'not found' });
  if (bug.reference) return res.status(403).json({ error: 'reference bug cannot be deleted' });
  try { await deleteBug(id); res.status(204).end(); } catch { res.status(500).json({ error: 'delete failed' }); }
});

// Delete all bugs (preserve reference bugs)
app.delete('/api/bugs', async (req, res) => {
  const all = await listBugs();
  const preserved = all.filter(b => b.reference);
  if (preserved.length === all.length) return res.status(403).json({ error: 'all bugs are reference bugs; deletion aborted' });
  try { await deleteAllNonReference(); res.setHeader('X-Reference-Preserved', preserved.length.toString()); return res.status(204).end(); } catch { res.status(500).json({ error: 'bulk delete failed' }); }
});

// Fallback 404 for unmatched API routes (not static assets)
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not found' });
});

// Centralized error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'internal error' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
