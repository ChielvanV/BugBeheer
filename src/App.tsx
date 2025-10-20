import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { initSupabase, getSupabase } from './supabaseClient';

// Types
interface BugRecord {
  id: string;
  ticket?: string;
  description: string;
  jiraLink?: string;
  impact: number;
  likelihood: number;
  label?: string;
  createdAt: number;
  completedAt?: number | null;
  reference?: boolean;
}

// Add DB row interface + mapper
interface BugRow {
  id: string;
  ticket: string | null;
  description: string;
  jira_link: string | null;
  impact: number;
  likelihood: number;
  label: string | null;
  completed_at: number | null;
  created_at: number;
  reference: boolean;
}
function mapRowToBug(r: BugRow): BugRecord {
  return {
    id: r.id,
    ticket: r.ticket || undefined,
    description: r.description,
    jiraLink: r.jira_link || undefined,
    impact: r.impact,
    likelihood: r.likelihood,
    label: r.label || undefined,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    reference: r.reference
  };
}

const IMPACT_LABELS = ["Niet merkbaar", "Klein", "Gemiddeld", "Groot", "Desastreus"]; // 1..5
const LIKELIHOOD_LABELS = ["Jaarlijks", "Maandelijks", "Wekelijks", "Dagelijks", "< Dagelijks"]; // 1..5

function riskCategory(score: number): string {
  if (score <= 4) return 'Laag';
  if (score <= 8) return 'Gemiddeld';
  if (score <= 12) return 'Hoog';
  return 'Kritiek';
}

function cellColor(score: number): string {
  if (score <= 4) return '#d1fae5'; // green light
  if (score <= 8) return '#fef9c3'; // yellow light
  if (score <= 12) return '#ffedd5'; // orange light
  return '#fee2e2'; // red light
}

const ALLOWED_LABELS = [
  'Betaalopdrachten',
  'Betaalverzoeken Parro',
  'Betaalverzoeken Email',
  'TSO',
  'Accounts / login',
  'Beheer & Instellingen'
];

const RISK_LEGEND: Record<string,string> = {
  'Kritiek': 'Alles laten vallen en meteen mee bezig',
  'Hoog': 'Binnen twee dagen oppakken',
  'Gemiddeld': 'Binnen de week oppakken',
  'Laag': 'Wanneer het uitkomt, geen haast'
};

// UUID helper for browser
const genId = () => (typeof crypto !== 'undefined' && (crypto as any).randomUUID ? (crypto as any).randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

const EXPECT_USER = process.env.REACT_APP_APP_USERNAME;
const EXPECT_PASS = process.env.REACT_APP_APP_PASSWORD;
const SESSION_MS = 5 * 60 * 1000; // 5 minuten

const App: React.FC = () => {
  // Obtain supabase instance (will be null until initSupabase() called after login)
  const [supabase, setSupabase] = useState(getSupabase());
  // Auth state
  const [authUser, setAuthUser] = useState<string | null>(() => {
    const storedUser = localStorage.getItem('bugauth_user');
    const ts = Number(localStorage.getItem('bugauth_ts')) || 0;
    if (!storedUser || !ts || Date.now() - ts > SESSION_MS) {
      localStorage.removeItem('bugauth_user');
      localStorage.removeItem('bugauth_ts');
      return null;
    }
    return storedUser;
  });
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);

  function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!EXPECT_USER || !EXPECT_PASS) {
      setLoginError('Auth niet geconfigureerd');
      return;
    }
    if (loginUser === EXPECT_USER && loginPass === EXPECT_PASS) {
      localStorage.setItem('bugauth_user', loginUser);
      localStorage.setItem('bugauth_ts', Date.now().toString());
      setAuthUser(loginUser);
      setLoginError(null);
      setLoginPass('');
      // Init Supabase client now that user is authenticated
      initSupabase();
      setSupabase(getSupabase());
      // Initial data load after client init
      reload();
    } else {
      setLoginError('Ongeldige inlog');
    }
  }
  function handleLogout() {
    localStorage.removeItem('bugauth_user');
    localStorage.removeItem('bugauth_ts');
    setAuthUser(null);
    // No explicit supabase teardown needed; keep singleton null state until next login
  }
  // Auto logout timer based on remaining session time
  useEffect(() => {
    if (!authUser) return;
    const ts = Number(localStorage.getItem('bugauth_ts')) || 0;
    const elapsed = Date.now() - ts;
    const remaining = SESSION_MS - elapsed;
    if (remaining <= 0) {
      handleLogout();
      return;
    }
    const timer = setTimeout(() => {
      handleLogout();
    }, remaining);
    return () => clearTimeout(timer);
  }, [authUser]);

  // Form state
  const [ticket, setTicket] = useState('');
  const [description, setDescription] = useState('');
  const [jiraLink, setJiraLink] = useState('');
  const [impact, setImpact] = useState<number>(3);
  const [likelihood, setLikelihood] = useState<number>(3);
  const [label, setLabel] = useState('');
  const [newReference, setNewReference] = useState(false); // creation reference flag

  // Data state
  const [bugs, setBugs] = useState<BugRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Interaction state
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Sort state
  const [sortField, setSortField] = useState<'none' | 'score'>('none');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // View tab state
  const [viewTab, setViewTab] = useState<'open' | 'completed'>('open');
  const [labelFilters, setLabelFilters] = useState<string[]>([]); // empty = alle labels

  // Edit form state for selected bug
  const [editTicket, setEditTicket] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editJiraLink, setEditJiraLink] = useState('');
  const [editImpact, setEditImpact] = useState<number>(3);
  const [editLikelihood, setEditLikelihood] = useState<number>(3);
  const [editLabel, setEditLabel] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [editReference, setEditReference] = useState(false); // edit reference flag
  const [showLegend, setShowLegend] = useState(false); // legend popup toggle

  const riskScore = impact * likelihood;

  function resetForm() {
    setTicket('');
    setDescription('');
    setJiraLink('');
    setImpact(3);
    setLikelihood(3);
    setLabel('');
    setNewReference(false);
  }

  // Add bug (async/await; removes unsupported .finally)
  async function addBug(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!description.trim()) return;
    if (!supabase) { setError('Niet ingelogd'); return; }
    const newRow: Partial<BugRow> = {
      id: genId(),
      ticket: ticket.trim() || null,
      description: description.trim(),
      jira_link: jiraLink.trim() || null,
      impact,
      likelihood,
      label: label.trim() || null,
      completed_at: null,
      created_at: Date.now(),
      reference: newReference
    };
    setLoading(true); setError(null);
    try {
      const { data, error } = await supabase.from('bugs').insert([newRow]).select();
      if (error) { setError('Kon bug niet toevoegen'); console.error(error); }
      else if (data && data[0]) { setBugs(prev => [...prev, mapRowToBug(data[0] as BugRow)]); resetForm(); }
    } catch (e) { console.error(e); setError('Onbekende fout bij toevoegen'); }
    finally { setLoading(false); }
  }

  async function clearAll() {
    if (!supabase) { setError('Niet ingelogd'); return; }
    if (!window.confirm('Weet je zeker dat je alle niet-referentie bugs wilt wissen?')) return;
    setLoading(true); setError(null);
    try {
      const { error } = await supabase.from('bugs').delete().eq('reference', false);
      if (error) { setError('Kon bugs niet wissen'); console.error(error); }
      else { setBugs(prev => prev.filter(b => b.reference)); setSelectedId(null); setHoveredId(null); }
    } catch (e) { console.error(e); setError('Onbekende fout bij wissen'); }
    finally { setLoading(false); }
  }

  const reload = useCallback(async () => {
    if (!supabase) return;
    setLoading(true); setError(null);
    try {
      const { data, error } = await supabase.from('bugs').select('*').order('created_at', { ascending: true });
      if (error) { setError('Kon bugs niet laden'); console.error(error); }
      else setBugs(((data as BugRow[]) || []).map(mapRowToBug));
    } catch (e) { console.error(e); setError('Onbekende fout bij laden'); }
    finally { setLoading(false); }
  }, [supabase]);

  function toggleLabelFilter(l: string) {
    setLabelFilters(prev => prev.includes(l) ? prev.filter(x => x !== l) : [...prev, l]);
  }
  function resetLabelFilters() { setLabelFilters([]); }

  // Replace markCompleted function to update row
  async function markCompleted(id: string) {
    if (!supabase) { setError('Niet ingelogd'); return; }
    setLoading(true); setError(null);
    try {
      const ts = Date.now();
      const { data, error } = await supabase.from('bugs').update({ completed_at: ts }).eq('id', id).select().single();
      if (error) { setError('Fout bij afronden'); console.error(error); }
      else if (data) setBugs(prev => prev.map(b => b.id === id ? mapRowToBug(data as BugRow) : b));
    } catch (e) { console.error(e); setError('Onbekende fout bij afronden'); }
    finally { setLoading(false); }
  }

  // Verwijder een bug (niet als reference)
  async function deleteBug(id: string) {
    if (!supabase) { setError('Niet ingelogd'); return; }
    const bug = bugs.find(b => b.id === id);
    if (!bug) return;
    if (bug.reference) { alert('Referentie bug kan niet worden verwijderd.'); return; }
    if (!window.confirm('Bug verwijderen?')) return;
    setLoading(true); setError(null);
    try {
      const { error } = await supabase.from('bugs').delete().eq('id', id);
      if (error) { setError('Kon bug niet verwijderen'); console.error(error); }
      else {
        setBugs(prev => prev.filter(b => b.id !== id));
        if (selectedId === id) setSelectedId(null);
      }
    } catch (e) { console.error(e); setError('Onbekende fout bij verwijderen'); }
    finally { setLoading(false); }
  }

  // Load selected bug into edit form
  useEffect(() => {
    if (!selectedId) {
      setEditTicket('');
      setEditDescription('');
      setEditJiraLink('');
      setEditImpact(3);
      setEditLikelihood(3);
      setEditLabel('');
      setEditError(null);
      setEditReference(false);
      return;
    }
    const bug = bugs.find(b => b.id === selectedId);
    if (!bug) return;
    setEditTicket(bug.ticket || '');
    setEditDescription(bug.description);
    setEditJiraLink(bug.jiraLink || '');
    setEditImpact(bug.impact);
    setEditLikelihood(bug.likelihood);
    setEditLabel(bug.label || '');
    setEditReference(!!bug.reference);
  }, [selectedId, bugs]);

  // Replace updateBug function
  async function updateBug(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedId) return;
    if (!editDescription.trim()) { setEditError('Omschrijving verplicht'); return; }
    if (!supabase) { setEditError('Niet ingelogd'); return; }
    const changes: Partial<BugRow> = {
      ticket: editTicket.trim() || null,
      description: editDescription.trim(),
      jira_link: editJiraLink.trim() || null,
      impact: editImpact,
      likelihood: editLikelihood,
      label: editLabel.trim() || null,
      reference: editReference
    };
    setEditLoading(true); setEditError(null);
    try {
      const { data, error } = await supabase.from('bugs').update(changes).eq('id', selectedId).select().single();
      if (error) { setEditError('Fout bij bijwerken'); console.error(error); }
      else if (data) { setBugs(prev => prev.map(b => b.id === selectedId ? mapRowToBug(data as BugRow) : b)); setSelectedId(selectedId); }
    } catch (e) { console.error(e); setEditError('Onbekende fout bij bijwerken'); }
    finally { setEditLoading(false); }
  }

  function cancelEdit() {
    setSelectedId(null);
  }

  // Initial load only after auth + client ready
  useEffect(() => {
    if (authUser && supabase) reload();
  }, [authUser, supabase, reload]);

  // Periodic refresh
  useEffect(() => {
    if (!authUser || !supabase) return;
    const interval = setInterval(() => {
      reload();
    }, 30000);
    return () => clearInterval(interval);
  }, [authUser, supabase, reload]);

  // Derived data
  const displayedBugs = useMemo(() => {
    return bugs.filter(b => {
      const statusOk = viewTab === 'open' ? !b.completedAt : !!b.completedAt;
      const labelOk = labelFilters.length === 0 || (b.label && labelFilters.includes(b.label));
      return statusOk && labelOk;
    });
  }, [bugs, viewTab, labelFilters]);

  const groupedBugs = useMemo(() => {
    const map: Record<string, BugRecord[]> = {};
    for (const b of displayedBugs) {
      const key = `${b.impact}-${b.likelihood}`;
      if (!map[key]) map[key] = [];
      map[key].push(b);
    }
    return map;
  }, [displayedBugs]);

  const sortedBugs = useMemo(() => {
    const arr = [...displayedBugs];
    if (sortField === 'score') {
      arr.sort((a, b) => {
        const sa = a.impact * a.likelihood;
        const sb = b.impact * b.likelihood;
        return sortDir === 'asc' ? sa - sb : sb - sa;
      });
    }
    return arr;
  }, [displayedBugs, sortField, sortDir]);

  // Styles
  const containerStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', minHeight: '100vh', padding: '1rem', fontFamily: 'system-ui, sans-serif', background: '#f8fafc', boxSizing: 'border-box'
  };
  const layoutStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem', width: '100%', alignItems: 'start' };
  const formCardStyle: React.CSSProperties = { background: 'white', padding: '1rem', borderRadius: '0.75rem', boxShadow: '0 2px 4px rgba(0,0,0,0.1)', display: 'flex', flexDirection: 'column', gap: '0.75rem' };
  const matrixWrapperStyle: React.CSSProperties = { background: 'white', padding: '1rem', borderRadius: '0.75rem', boxShadow: '0 2px 4px rgba(0,0,0,0.1)', overflowX: 'auto', position:'relative' };
  const matrixGridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(6, minmax(90px, 1fr))', gridTemplateRows: 'repeat(6, minmax(70px, 1fr))', border: '2px solid #e2e8f0', borderRadius: '0.5rem' };
  const axisCellBase: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', fontWeight: 600, padding: '0.25rem', textAlign: 'center' };
  const bugTableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' };
  const chipStyle: React.CSSProperties = { display: 'inline-block', background: '#e0f2fe', color: '#0369a1', padding: '0 0.5rem', borderRadius: '999px', fontSize: '0.65rem', lineHeight: '1.5rem', fontWeight: 600 };
  function markerStyle(b: BugRecord): React.CSSProperties { const isHovered = hoveredId === b.id; const isSelected = selectedId === b.id; return { width: isSelected ? 20 : 14, height: isSelected ? 20 : 14, borderRadius: '50%', background: '#0f172a', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.55rem', cursor: 'pointer', border: isHovered || isSelected ? '2px solid #38bdf8' : '2px solid transparent', transform: isHovered ? 'scale(1.3)' : 'scale(1)', transition: 'all 120ms ease' }; }
  const responsiveHint: React.CSSProperties = { fontSize: '0.65rem', color: '#64748b', marginTop: '-0.25rem' };
  const tabBarStyle: React.CSSProperties = { display: 'flex', gap: '0.25rem', marginBottom: '0.75rem', borderBottom: '2px solid #cbd5e1' };
  function tabStyle(active: boolean): React.CSSProperties { return { position: 'relative', background: active ? '#ffffff' : '#e2e8f0', color: active ? '#0f172a' : '#475569', padding: '0.5rem 1rem', fontSize: '0.7rem', fontWeight: 600, border: '1px solid #cbd5e1', borderBottom: active ? '2px solid #ffffff' : '2px solid #cbd5e1', borderTopLeftRadius: '0.5rem', borderTopRightRadius: '0.5rem', cursor: 'pointer', boxShadow: active ? '0 -1px 4px rgba(0,0,0,0.08)' : 'none', transform: active ? 'translateY(0)' : 'translateY(2px)', transition: 'all 140ms ease', display: 'flex', alignItems: 'center', gap: '0.4rem' }; }

  // Gate UI if not logged in
  if (!authUser) {
    return (
      <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'#f1f5f9', fontFamily:'system-ui, sans-serif' }}>
        <form onSubmit={handleLogin} style={{ background:'#ffffff', padding:'1.5rem', borderRadius:12, width:300, display:'flex', flexDirection:'column', gap:'0.75rem', boxShadow:'0 4px 16px rgba(0,0,0,0.08)' }}>
          <h1 style={{ margin:0, fontSize:'1.1rem', textAlign:'center' }}>Bugbeheer Login</h1>
          <label style={{ display:'flex', flexDirection:'column', gap:'0.25rem', fontSize:'0.7rem' }}>Gebruiker
            <input value={loginUser} onChange={e=>setLoginUser(e.target.value)} style={{ padding:'0.5rem', border:'1px solid #cbd5e1', borderRadius:6 }} autoComplete="username" />
          </label>
          <label style={{ display:'flex', flexDirection:'column', gap:'0.25rem', fontSize:'0.7rem' }}>Wachtwoord
            <input type="password" value={loginPass} onChange={e=>setLoginPass(e.target.value)} style={{ padding:'0.5rem', border:'1px solid #cbd5e1', borderRadius:6 }} autoComplete="current-password" />
          </label>
          {loginError && <div style={{ fontSize:'0.65rem', color:'#dc2626' }}>{loginError}</div>}
          <button type="submit" style={{ background:'#0f172a', color:'#fff', padding:'0.6rem 0.9rem', border:'none', borderRadius:6, fontSize:'0.75rem', cursor:'pointer' }}>Inloggen</button>
          <div style={{ fontSize:'0.55rem', color:'#64748b', textAlign:'center' }}>Let op: sessie verloopt na 5 minuten.</div>
        </form>
      </div>
    );
  }

  // Main screen
  return (
    <div style={containerStyle}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700 }}>Risicomatrix voor Bugs</h1>
        <div style={{ display:'flex', alignItems:'center', gap:'0.5rem' }}>
          <SessionCountdown />
          <button type="button" onClick={handleLogout} style={{ background:'#dc2626', color:'#fff', border:'none', padding:'0.45rem 0.75rem', borderRadius:6, fontSize:'0.65rem', cursor:'pointer' }}>Uitloggen</button>
        </div>
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:'0.5rem', marginTop:'0.25rem', marginBottom:'0.75rem' }}>
        <p style={{ margin:0, fontSize: '0.75rem', color: '#475569' }}>Voer bugs in en beoordeel risico op basis van Impact en Kans.</p>
        {/* Info button moved to Risicomatrix header */}
      </div>
      {showLegend && (
        /* Legend removed from global absolute position; now shown inside matrix card */
        <></>
      )}

      <div style={layoutStyle}>
        <form onSubmit={addBug} style={formCardStyle}>
          <h2 style={{ fontSize: '1rem', margin: 0 }}>Nieuwe Bug</h2>
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>Ticket nr.
              <input value={ticket} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTicket(e.target.value)} placeholder="Optional" style={{ padding: '0.4rem', borderRadius: 6, border: '1px solid #cbd5e1' }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>Bug omschrijving *
              <textarea value={description} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)} required rows={3} style={{ padding: '0.4rem', borderRadius: 6, border: '1px solid #cbd5e1', resize: 'vertical' }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>Jira link
              <input type="url" value={jiraLink} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setJiraLink(e.target.value)} placeholder="https://" style={{ padding: '0.4rem', borderRadius: 6, border: '1px solid #cbd5e1' }} />
            </label>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>Impact
                <select value={impact} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setImpact(Number(e.target.value))} style={{ padding: '0.4rem', borderRadius: 6, border: '1px solid #cbd5e1' }}>
                  {[1,2,3,4,5].map(i => <option key={i} value={i}>{i} - {IMPACT_LABELS[i-1]}</option>)}
                </select>
              </label>
              <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>Kans
                <select value={likelihood} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setLikelihood(Number(e.target.value))} style={{ padding: '0.4rem', borderRadius: 6, border: '1px solid #cbd5e1' }}>
                  {[1,2,3,4,5].map(i => <option key={i} value={i}>{i} - {LIKELIHOOD_LABELS[i-1]}</option>)}
                </select>
              </label>
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>Label
              <select value={label} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setLabel(e.target.value)} style={{ padding: '0.4rem', borderRadius: 6, border: '1px solid #cbd5e1' }}>
                <option value="">-- Kies label --</option>
                {ALLOWED_LABELS.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:'0.5rem', fontSize:'0.65rem' }}>
            <label style={{ display:'flex', alignItems:'center', gap:'0.35rem', cursor:'pointer' }}>
              <input type="checkbox" checked={newReference} onChange={e=>setNewReference(e.target.checked)} /> Referentie bug (niet afrondbaar / niet verwijderbaar)
            </label>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#334155', fontWeight: 600 }}>Risico score: {riskScore} ({riskCategory(riskScore)})</div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="submit" style={{ background: '#0f172a', color: 'white', padding: '0.5rem 0.9rem', border: 'none', borderRadius: 6, fontSize: '0.75rem', cursor: 'pointer' }}>Toevoegen</button>
            <button type="button" onClick={resetForm} style={{ background: '#475569', color: 'white', padding: '0.5rem 0.9rem', border: 'none', borderRadius: 6, fontSize: '0.75rem', cursor: 'pointer' }}>Reset</button>
            <button type="button" onClick={clearAll} style={{ background: '#dc2626', color: 'white', padding: '0.5rem 0.9rem', border: 'none', borderRadius: 6, fontSize: '0.75rem', cursor: 'pointer' }}>Alles wissen</button>
            <button type="button" onClick={reload} disabled={loading} style={{ background: '#0d9488', color: 'white', padding: '0.5rem 0.9rem', border: 'none', borderRadius: 6, fontSize: '0.75rem', cursor: 'pointer', marginLeft: 'auto', opacity: loading ? 0.7 : 1 }}>Herladen</button>
          </div>
          <div style={responsiveHint}>Responsief: matrix en lijst schalen mee.</div>
          {loading && <div style={{ fontSize: '0.65rem', color: '#475569' }}>Bezig...</div>}
          {error && <div style={{ fontSize: '0.65rem', color: '#dc2626' }}>{error}</div>}
        </form>

        <div style={matrixWrapperStyle}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'0.5rem' }}>
            <h2 style={{ fontSize: '1rem', margin: 0 }}>Risicomatrix</h2>
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={showLegend}
              onClick={() => setShowLegend(s=>!s)}
              style={{ width:24, height:24, borderRadius:'50%', border:'1px solid #0f172a', background:'#fff', color:'#0f172a', fontSize:'0.8rem', fontWeight:700, cursor:'pointer', lineHeight:1 }}
              title={showLegend ? 'Verberg legenda' : 'Toon legenda'}
            >i</button>
          </div>
          {showLegend && (
            <div role="dialog" aria-label="Risico legenda" style={{ position:'absolute', top:50, right:12, zIndex:10, background:'#ffffff', border:'1px solid #cbd5e1', borderRadius:8, padding:'0.75rem', width:250, boxShadow:'0 4px 12px rgba(0,0,0,0.12)', display:'flex', flexDirection:'column', gap:'0.4rem' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <strong style={{ fontSize:'0.8rem' }}>Legenda risiconiveaus</strong>
                <button type="button" onClick={()=>setShowLegend(false)} style={{ background:'transparent', border:'none', cursor:'pointer', fontSize:'0.8rem', color:'#0f172a' }}>×</button>
              </div>
              {['Kritiek','Hoog','Gemiddeld','Laag'].map(level => (
                <div key={level} style={{ display:'flex', flexDirection:'column', fontSize:'0.65rem' }}>
                  <span style={{ fontWeight:600 }}>{level}</span>
                  <span style={{ color:'#475569' }}>{RISK_LEGEND[level]}</span>
                </div>
              ))}
              <div style={{ marginTop:'0.25rem', textAlign:'right' }}>
                <button type="button" onClick={()=>setShowLegend(false)} style={{ background:'#0f172a', color:'#fff', border:'none', borderRadius:4, padding:'0.25rem 0.5rem', fontSize:'0.6rem', cursor:'pointer' }}>Sluiten</button>
              </div>
            </div>
          )}
          <div style={matrixGridStyle}>
            <div style={{ ...axisCellBase, background: '#f1f5f9', fontSize: '0.6rem' }}>Kans ↓ / Impact →</div>
            {IMPACT_LABELS.map((lbl, i) => (
              <div key={lbl} style={{ ...axisCellBase, background: '#f1f5f9' }}>{i+1}<br/><span style={{ fontWeight: 400 }}>{lbl}</span></div>
            ))}
            {LIKELIHOOD_LABELS.map((ylbl, yi) => (
              <React.Fragment key={ylbl}>
                <div style={{ ...axisCellBase, background: '#f1f5f9' }}>{yi+1}<br/><span style={{ fontWeight: 400 }}>{ylbl}</span></div>
                {IMPACT_LABELS.map((_, xi) => {
                  const score = (xi+1)*(yi+1);
                  const key = `${xi+1}-${yi+1}`;
                  const bugsInCell = groupedBugs[key] || [];
                  return (
                    <div key={key} style={{ position: 'relative', background: cellColor(score), border: '1px solid #e2e8f0', padding: '2px', display: 'flex', flexDirection: 'column', fontSize: '0.55rem', overflow: 'hidden' }}>
                      <div style={{ fontWeight: 600 }}>{riskCategory(score)}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px', marginTop: '2px' }}>
                        {bugsInCell.map((b: BugRecord) => (
                          <div
                            key={b.id}
                            title={b.description}
                            style={markerStyle(b)}
                            onMouseEnter={() => setHoveredId(b.id)}
                            onMouseLeave={() => setHoveredId(prev => prev === b.id ? null : prev)}
                            onClick={() => setSelectedId(b.id)}
                          >
                            {b.ticket ? b.ticket.substring(0,3).toUpperCase() : '•'}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      <div style={{ marginTop: '1.25rem', background: 'white', padding: '1rem', borderRadius: '0.75rem', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
        <h2 style={{ fontSize: '1rem', margin: 0, marginBottom: '0.75rem' }}>Bugs</h2>
        <div style={tabBarStyle} role="tablist" aria-label="Bug status tabs">
          <button role="tab" aria-selected={viewTab==='open'} style={tabStyle(viewTab==='open')} onClick={() => setViewTab('open')}>
            Open bugs
            {viewTab==='open' && <span style={{ background:'#0d9488', color:'white', fontSize:'0.55rem', padding:'0 0.4rem', borderRadius:'999px' }}>{bugs.filter(b=>!b.completedAt).length}</span>}
          </button>
          <button role="tab" aria-selected={viewTab==='completed'} style={tabStyle(viewTab==='completed')} onClick={() => setViewTab('completed')}>
            Afgeronde bugs
            {viewTab==='completed' && <span style={{ background:'#0d9488', color:'white', fontSize:'0.55rem', padding:'0 0.4rem', borderRadius:'999px' }}>{bugs.filter(b=>b.completedAt).length}</span>}
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginBottom: '0.5rem' }}>
          <div style={{ fontSize: '0.65rem', fontWeight: 600 }}>Filter op labels:</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
            {ALLOWED_LABELS.map(l => (
              <button key={l} type="button" onClick={() => toggleLabelFilter(l)} style={{ background: labelFilters.includes(l) ? '#0d9488' : '#e2e8f0', color: labelFilters.includes(l) ? 'white' : '#0f172a', border: 'none', padding: '0.3rem 0.6rem', borderRadius: 999, fontSize: '0.6rem', cursor: 'pointer' }}>{l}</button>
            ))}
            <button type="button" onClick={resetLabelFilters} style={{ background: '#dc2626', color: 'white', border: 'none', padding: '0.3rem 0.6rem', borderRadius: 999, fontSize: '0.6rem', cursor: 'pointer' }}>Reset</button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
          <label style={{ fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>Sorteren op
            <select value={sortField} onChange={(e) => setSortField(e.target.value as any)} style={{ padding: '0.3rem', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: '0.7rem' }}>
              <option value="none">Geen</option>
              <option value="score">Score</option>
            </select>
          </label>
          <button type="button" onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')} style={{ background: '#0f172a', color: 'white', padding: '0.3rem 0.6rem', border: 'none', borderRadius: 6, fontSize: '0.65rem', cursor: 'pointer' }}>
            Richting: {sortDir === 'asc' ? '↑' : '↓'}
          </button>
          {sortField !== 'none' && <span style={{ fontSize: '0.6rem', color: '#64748b' }}>Huidig: {sortField} ({sortDir})</span>}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={bugTableStyle}>
            <thead>
              <tr style={{ background: '#f1f5f9' }}>
                <th style={{ padding: '0.5rem', border: '1px solid #e2e8f0' }}>Ticket</th>
                <th style={{ padding: '0.5rem', border: '1px solid #e2e8f0' }}>Omschrijving</th>
                <th style={{ padding: '0.5rem', border: '1px solid #e2e8f0' }}>Jira</th>
                <th style={{ padding: '0.5rem', border: '1px solid #e2e8f0' }}>Impact</th>
                <th style={{ padding: '0.5rem', border: '1px solid #e2e8f0' }}>Kans</th>
                <th style={{ padding: '0.5rem', border: '1px solid #e2e8f0' }}>Score</th>
                <th style={{ padding: '0.5rem', border: '1px solid #e2e8f0' }}>Label</th>
                <th style={{ padding: '0.5rem', border: '1px solid #e2e8f0' }}>Actie</th>
              </tr>
            </thead>
            <tbody>
              {sortedBugs.map((b: BugRecord) => {
                const score = b.impact * b.likelihood;
                const isHovered = hoveredId === b.id;
                const isSelected = selectedId === b.id;
                return (
                  <tr key={b.id} style={{ background: isSelected ? '#bae6fd' : isHovered ? '#e0f2fe' : 'transparent', cursor: 'pointer', transition: 'background 120ms' }} onMouseEnter={() => setHoveredId(b.id)} onMouseLeave={() => setHoveredId(prev => prev === b.id ? null : prev)} onClick={() => setSelectedId(b.id)}>
                    <td style={{ padding: '0.4rem 0.5rem', border: '1px solid #e2e8f0' }}>{b.ticket || '-'}</td>
                    <td style={{ padding: '0.4rem 0.5rem', border: '1px solid #e2e8f0', textAlign: 'left' }}>{b.description}</td>
                    <td style={{ padding: '0.4rem 0.5rem', border: '1px solid #e2e8f0' }}>{b.jiraLink ? <a href={b.jiraLink} target="_blank" rel="noopener noreferrer">Link</a> : '-'}</td>
                    <td style={{ padding: '0.4rem 0.5rem', border: '1px solid #e2e8f0' }}>{b.impact} ({IMPACT_LABELS[b.impact-1]})</td>
                    <td style={{ padding: '0.4rem 0.5rem', border: '1px solid #e2e8f0' }}>{b.likelihood} ({LIKELIHOOD_LABELS[b.likelihood-1]})</td>
                    <td style={{ padding: '0.4rem 0.5rem', border: '1px solid #e2e8f0' }}>{score} {riskCategory(score)}</td>
                    <td style={{ padding: '0.4rem 0.5rem', border: '1px solid #e2e8f0' }}>{b.label ? <span style={chipStyle}>{b.label}</span> : '-'} {b.reference && <span style={{ ...chipStyle, background:'#fde68a', color:'#92400e', marginLeft:4 }}>REF</span>}</td>
                    <td style={{ padding: '0.4rem 0.5rem', border: '1px solid #e2e8f0' }}>
                      {viewTab === 'open' && !b.completedAt && !b.reference && (
                        <button type="button" onClick={(e) => { e.stopPropagation(); markCompleted(b.id); }} style={{ background: '#0d9488', color: 'white', padding: '0.3rem 0.6rem', border: 'none', borderRadius: 6, fontSize: '0.6rem', cursor: 'pointer', marginRight: 4 }}>Afronden</button>
                      )}
                      <button type="button" onClick={(e) => { e.stopPropagation(); setSelectedId(b.id); }} style={{ background: '#475569', color: 'white', padding: '0.3rem 0.6rem', border: 'none', borderRadius: 6, fontSize: '0.6rem', cursor: 'pointer', marginRight: 4 }}>Bewerken</button>
                      {!b.reference && (
                        <button type="button" onClick={(e) => { e.stopPropagation(); deleteBug(b.id); }} style={{ background: '#dc2626', color: 'white', padding: '0.3rem 0.6rem', border: 'none', borderRadius: 6, fontSize: '0.6rem', cursor: 'pointer' }}>Verwijderen</button>
                      )}
                      {viewTab === 'completed' && b.completedAt && (
                        <span style={{ display: 'block', marginTop: 4, fontSize: '0.55rem', color: '#0d9488' }}>Afrond: {new Date(b.completedAt).toLocaleDateString()}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {sortedBugs.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ padding: '1rem', textAlign: 'center', fontSize: '0.8rem', color: '#64748b' }}>Geen bugs voor deze selectie.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {selectedId && (
          <div style={{ marginTop: '1rem', background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 8, padding: '0.75rem' }}>
            <h3 style={{ margin: 0, fontSize: '0.9rem' }}>Bug bewerken</h3>
            <form onSubmit={updateBug} style={{ display: 'grid', gap: '0.5rem', marginTop: '0.5rem' }}>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>Ticket
                  <input value={editTicket} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditTicket(e.target.value)} style={{ padding: '0.4rem', borderRadius: 6, border: '1px solid #cbd5e1' }} />
                </label>
                <label style={{ flex: 2, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>Jira link
                  <input type="url" value={editJiraLink} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditJiraLink(e.target.value)} style={{ padding: '0.4rem', borderRadius: 6, border: '1px solid #cbd5e1' }} />
                </label>
              </div>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>Omschrijving *
                <textarea value={editDescription} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditDescription(e.target.value)} required rows={3} style={{ padding: '0.4rem', borderRadius: 6, border: '1px solid #cbd5e1', resize: 'vertical' }} />
              </label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>Impact
                  <select value={editImpact} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setEditImpact(Number(e.target.value))} style={{ padding: '0.4rem', borderRadius: 6, border: '1px solid #cbd5e1' }}>
                    {[1,2,3,4,5].map(i => <option key={i} value={i}>{i} - {IMPACT_LABELS[i-1]}</option>)}
                  </select>
                </label>
                <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>Kans
                  <select value={editLikelihood} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setEditLikelihood(Number(e.target.value))} style={{ padding: '0.4rem', borderRadius: 6, border: '1px solid #cbd5e1' }}>
                    {[1,2,3,4,5].map(i => <option key={i} value={i}>{i} - {LIKELIHOOD_LABELS[i-1]}</option>)}
                  </select>
                </label>
                <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>Label
                  <select value={editLabel} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setEditLabel(e.target.value)} style={{ padding: '0.4rem', borderRadius: 6, border: '1px solid #cbd5e1' }}>
                    <option value="">-- Geen --</option>
                    {ALLOWED_LABELS.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                </label>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:'0.5rem', fontSize:'0.65rem' }}>
                <label style={{ display:'flex', alignItems:'center', gap:'0.35rem', cursor:'pointer' }}>
                  <input type="checkbox" checked={editReference} onChange={e=>setEditReference(e.target.checked)} /> Referentie bug
                </label>
                {editReference && <span style={{ ...chipStyle, background:'#fde68a', color:'#92400e' }}>REF</span>}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <button type="submit" disabled={editLoading} style={{ background: '#0d9488', color: 'white', padding: '0.4rem 0.8rem', border: 'none', borderRadius: 6, fontSize: '0.65rem', cursor: 'pointer' }}>{editLoading ? 'Opslaan...' : 'Opslaan'}</button>
                <button type="button" onClick={cancelEdit} disabled={editLoading} style={{ background: '#475569', color: 'white', padding: '0.4rem 0.8rem', border: 'none', borderRadius: 6, fontSize: '0.65rem', cursor: 'pointer' }}>Annuleren</button>
                {editError && <span style={{ fontSize: '0.6rem', color: '#dc2626' }}>{editError}</span>}
              </div>
            </form>
          </div>
        )}
      </div>

      <footer style={{ marginTop: 'auto', fontSize: '0.6rem', textAlign: 'center', color: '#94a3b8' }}>
        Data wordt persistent opgeslagen in Supabase (tabel bugs).
      </footer>
    </div>
  );
};
// Countdown component
function SessionCountdown() {
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    function update() {
      const ts = Number(localStorage.getItem('bugauth_ts')) || 0;
      if (!ts) { setRemaining(0); return; }
      const rem = SESSION_MS - (Date.now() - ts);
      setRemaining(rem > 0 ? rem : 0);
    }
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, []);
  if (remaining <= 0) return null;
  const seconds = Math.floor(remaining / 1000) % 60;
  const minutes = Math.floor(remaining / 60000);
  return <span style={{ fontSize:'0.6rem', color:'#475569' }}>Verloopt in {minutes}:{seconds.toString().padStart(2,'0')}</span>;
}

export default App;
