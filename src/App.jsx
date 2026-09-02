import { useState, useEffect, useRef, useCallback } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — fill these in before deploying
// ─────────────────────────────────────────────────────────────────────────────
const MOD_PASSWORD = 'streammod2024'         // change this!
const FIREBASE_URL = 'YOUR_FIREBASE_URL_HERE' // e.g. https://my-project-default-rtdb.firebaseio.com

// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_STATE = {
  active: false,
  type: null,
  url: '',
  label: '',
  volume: 80,
  loop: false,
  fit: 'contain',
  timestamp: 0,
}

function parseYouTubeId(url) {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([a-zA-Z0-9_-]{11})/)
  return m ? m[1] : null
}

function detectType(url) {
  if (!url) return null
  if (parseYouTubeId(url) || /\.(mp4|webm|ogg)(\?|$)/i.test(url)) return 'video'
  if (/\.(jpe?g|png|gif|webp|svg)(\?|$)/i.test(url)) return 'image'
  return null
}

// Firebase helpers — plain REST, no SDK needed
async function fbGet() {
  const res = await fetch(`${FIREBASE_URL}/overlay.json`)
  if (!res.ok) throw new Error('Firebase read failed')
  return await res.json()
}

async function fbSet(data) {
  const res = await fetch(`${FIREBASE_URL}/overlay.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Firebase write failed')
}

// ─── Overlay ──────────────────────────────────────────────────────────────────
function Overlay() {
  const [state, setState] = useState(DEFAULT_STATE)
  const lastTs = useRef(0)

  useEffect(() => {
    const poll = async () => {
      try {
        const data = await fbGet()
        if (data && data.timestamp !== lastTs.current) {
          lastTs.current = data.timestamp
          setState(data)
        }
      } catch (_) {}
    }
    poll()
    const id = setInterval(poll, 800)
    return () => clearInterval(id)
  }, [])

  const autoClear = useCallback(async () => {
    try {
      const cleared = { ...DEFAULT_STATE, timestamp: Date.now() }
      await fbSet(cleared)
      setState(cleared)
      lastTs.current = cleared.timestamp
    } catch (_) {}
  }, [])

  // YouTube IFrame API sends postMessage when video ends (state 0)
  useEffect(() => {
    const handler = (e) => {
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
        if (data?.event === 'onStateChange' && data?.info === 0) autoClear()
      } catch (_) {}
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [autoClear])

  const ytId = state.url ? parseYouTubeId(state.url) : null

  return (
    <div style={{
      width: '100vw', height: '100vh', background: 'transparent',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden', position: 'relative',
    }}>
      {/* Resize grip — visible in bottom-right corner */}
      <div
        style={{
          position: 'absolute', bottom: 0, right: 0,
          width: 40, height: 40, cursor: 'nwse-resize',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
          padding: 6, boxSizing: 'border-box', zIndex: 9999,
        }}
        onMouseEnter={() => {
          if (window.__TAURI__) window.__TAURI__.core.invoke('set_clickthrough', { enabled: false })
        }}
        onMouseLeave={() => {
          if (window.__TAURI__) window.__TAURI__.core.invoke('set_clickthrough', { enabled: true })
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <line x1="14" y1="2" x2="2" y2="14" stroke="white" strokeWidth="1.5" strokeOpacity="0.6"/>
          <line x1="14" y1="7" x2="7" y2="14" stroke="white" strokeWidth="1.5" strokeOpacity="0.6"/>
          <line x1="14" y1="12" x2="12" y2="14" stroke="white" strokeWidth="1.5" strokeOpacity="0.6"/>
        </svg>
      </div>
      {state.active && state.type === 'image' && (
        <img
          key={state.timestamp}
          src={state.url}
          alt=""
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: state.fit || 'contain' }}
        />
      )}

      {state.active && state.type === 'video' && ytId && (
        <iframe
          key={state.timestamp}
          src={`https://www.youtube.com/embed/${ytId}?autoplay=1&loop=${state.loop ? 1 : 0}&playlist=${ytId}&enablejsapi=1`}
          allow="autoplay; fullscreen"
          style={{ width: '100%', height: '100%', border: 'none' }}
        />
      )}

      {state.active && state.type === 'video' && !ytId && (
        <video
          key={state.timestamp}
          src={state.url}
          autoPlay
          loop={state.loop}
          onEnded={() => { if (!state.loop) autoClear() }}
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: state.fit || 'contain' }}
        />
      )}
    </div>
  )
}

// ─── Control panel ────────────────────────────────────────────────────────────
function ControlPanel() {
  const [authed, setAuthed] = useState(false)
  const [pw, setPw] = useState('')
  const [pwErr, setPwErr] = useState('')

  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [volume, setVolume] = useState(80)
  const [loop, setLoop] = useState(false)
  const [fit, setFit] = useState('contain')
  const [urlErr, setUrlErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')
  const [liveState, setLiveState] = useState(DEFAULT_STATE)
  const [presets, setPresets] = useState([])
  const [presetName, setPresetName] = useState('')

  useEffect(() => {
    const saved = localStorage.getItem('stream-mod-presets')
    if (saved) setPresets(JSON.parse(saved))
  }, [])

  useEffect(() => {
    if (!authed) return
    const poll = async () => {
      try { const d = await fbGet(); if (d) setLiveState(d) } catch (_) {}
    }
    poll()
    const id = setInterval(poll, 1000)
    return () => clearInterval(id)
  }, [authed])

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2500) }

  const push = async (patch) => {
    setSaving(true)
    const next = { ...liveState, ...patch, timestamp: Date.now() }
    try {
      await fbSet(next)
      setLiveState(next)
      showToast(patch.active === false ? 'Overlay cleared' : 'Overlay updated')
    } catch {
      showToast('Error — check your Firebase URL')
    }
    setSaving(false)
  }

  const handleSend = async () => {
    if (!url.trim()) { setUrlErr('Enter a URL'); return }
    const type = detectType(url.trim())
    if (!type) { setUrlErr('Must be a YouTube link, .mp4/.webm, or image URL (.jpg .png .gif .webp)'); return }
    setUrlErr('')
    await push({ active: true, type, url: url.trim(), label, volume, loop, fit })
  }

  const handleClear = () => push({ ...DEFAULT_STATE, active: false })

  const savePreset = () => {
    if (!url.trim() || !presetName.trim()) return
    const p = { name: presetName, url, label, volume, loop, fit }
    const updated = [...presets.filter(x => x.name !== presetName), p]
    setPresets(updated)
    localStorage.setItem('stream-mod-presets', JSON.stringify(updated))
    setPresetName('')
    showToast('Preset saved')
  }

  const deletePreset = (name) => {
    const updated = presets.filter(x => x.name !== name)
    setPresets(updated)
    localStorage.setItem('stream-mod-presets', JSON.stringify(updated))
  }

  const sendPreset = (p) => push({
    active: true, type: detectType(p.url),
    url: p.url, label: p.label, volume: p.volume, loop: p.loop, fit: p.fit,
  })

  // ── Login screen ──
  if (!authed) {
    return (
      <div style={s.loginWrap}>
        <div style={s.loginBox}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🎬</div>
          <h2 style={s.loginTitle}>Mod control panel</h2>
          <p style={s.loginSub}>Enter the mod password to continue</p>
          <input
            type="password"
            placeholder="Password"
            value={pw}
            onChange={e => { setPw(e.target.value); setPwErr('') }}
            onKeyDown={e => {
              if (e.key !== 'Enter') return
              pw === MOD_PASSWORD ? setAuthed(true) : setPwErr('Wrong password')
            }}
            style={s.input}
          />
          {pwErr && <div style={s.err}>{pwErr}</div>}
          <button
            style={s.btn}
            onClick={() => pw === MOD_PASSWORD ? setAuthed(true) : setPwErr('Wrong password')}
          >
            Sign in
          </button>
        </div>
      </div>
    )
  }

  // ── Main panel ──
  return (
    <div style={s.wrap}>
      {toast && <div style={s.toast}>{toast}</div>}

      <div style={s.inner}>
        {/* Header */}
        <div style={s.header}>
          <div>
            <h1 style={s.h1}>Stream overlay</h1>
            <p style={s.sub}>Mod control panel</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ ...s.dot, background: liveState.active ? '#22c55e' : '#6b7280' }} />
            <span style={s.sub}>{liveState.active ? `Live · ${liveState.type}` : 'No overlay'}</span>
          </div>
        </div>

        {/* Live status bar */}
        {liveState.active && (
          <div style={s.liveBar}>
            <div>
              <span style={{ fontWeight: 500, color: '#15803d', fontSize: 14 }}>
                {liveState.label || liveState.url.slice(0, 60)}
              </span>
              <span style={{ fontSize: 12, color: '#16a34a', marginLeft: 8, opacity: 0.8 }}>
                {liveState.type} · {liveState.fit}
                {liveState.type === 'video' && ` · ${liveState.volume}%`}
                {liveState.loop && ' · looping'}
              </span>
            </div>
            <button style={s.clearBtn} onClick={handleClear}>Clear</button>
          </div>
        )}

        {/* Form */}
        <div style={s.card}>
          <label style={s.label}>URL</label>
          <input
            type="url"
            placeholder="YouTube link, .mp4, .jpg, .gif, .png…"
            value={url}
            onChange={e => { setUrl(e.target.value); setUrlErr('') }}
            style={{ ...s.input, marginBottom: urlErr ? 4 : 12 }}
          />
          {urlErr && <div style={{ ...s.err, marginBottom: 8 }}>{urlErr}</div>}

          <label style={s.label}>Label (optional)</label>
          <input
            type="text"
            placeholder="e.g. Raid gif, hype clip…"
            value={label}
            onChange={e => setLabel(e.target.value)}
            style={{ ...s.input, marginBottom: 12 }}
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={s.label}>Fit</label>
              <select value={fit} onChange={e => setFit(e.target.value)} style={s.select}>
                <option value="contain">Contain (letterbox)</option>
                <option value="cover">Cover (fill screen)</option>
                <option value="fill">Stretch</option>
              </select>
            </div>
            <div>
              <label style={s.label}>Volume — {volume}%</label>
              <input
                type="range" min={0} max={100} step={1} value={volume}
                onChange={e => setVolume(+e.target.value)}
                style={{ width: '100%', marginTop: 6 }}
              />
            </div>
          </div>

          <label style={{ ...s.label, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 16 }}>
            <input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)} />
            Loop video
          </label>

          <button style={{ ...s.btn, width: '100%' }} onClick={handleSend} disabled={saving}>
            {saving ? 'Sending…' : 'Send to overlay'}
          </button>
        </div>

        {/* Presets */}
        <div style={s.card}>
          <h3 style={s.h3}>Saved presets</h3>
          {presets.length === 0 && (
            <p style={{ ...s.sub, marginBottom: 12 }}>No presets yet — fill in a URL above and save it.</p>
          )}
          {presets.map(p => (
            <div key={p.name} style={s.presetRow}>
              <div style={{ minWidth: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{p.name}</span>
                <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 8 }}>
                  {p.url.slice(0, 45)}{p.url.length > 45 ? '…' : ''}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button style={s.smBtn} onClick={() => { setUrl(p.url); setLabel(p.label); setVolume(p.volume); setLoop(p.loop); setFit(p.fit) }}>Load</button>
                <button style={s.smBtn} onClick={() => sendPreset(p)}>Send</button>
                <button style={{ ...s.smBtn, color: '#ef4444', borderColor: '#fca5a5' }} onClick={() => deletePreset(p.name)}>✕</button>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <input
              type="text"
              placeholder="Preset name…"
              value={presetName}
              onChange={e => setPresetName(e.target.value)}
              style={{ ...s.input, flex: 1, marginBottom: 0 }}
            />
            <button style={s.btn} onClick={savePreset}>Save</button>
          </div>
        </div>

        <button
          style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: 12, cursor: 'pointer', marginTop: 8 }}
          onClick={() => setAuthed(false)}
        >
          Sign out
        </button>
      </div>
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s = {
  loginWrap: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a', fontFamily: 'system-ui, sans-serif' },
  loginBox: { background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: '2rem 2.5rem', width: 320, textAlign: 'center', color: '#f1f5f9' },
  loginTitle: { margin: '0 0 4px', fontSize: 18, fontWeight: 500, color: '#f1f5f9' },
  loginSub: { margin: '0 0 1.25rem', fontSize: 13, color: '#94a3b8' },
  wrap: { minHeight: '100vh', background: '#0f172a', padding: '1.5rem', boxSizing: 'border-box', fontFamily: 'system-ui, sans-serif', color: '#f1f5f9' },
  inner: { maxWidth: 640, margin: '0 auto' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' },
  h1: { margin: 0, fontSize: 20, fontWeight: 500, color: '#f1f5f9' },
  h3: { margin: '0 0 12px', fontSize: 15, fontWeight: 500, color: '#f1f5f9' },
  sub: { margin: '2px 0 0', fontSize: 13, color: '#94a3b8' },
  dot: { width: 8, height: 8, borderRadius: '50%' },
  card: { background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: '1.25rem', marginBottom: '1rem' },
  label: { fontSize: 13, color: '#94a3b8', display: 'block', marginBottom: 6 },
  input: { width: '100%', boxSizing: 'border-box', background: '#0f172a', border: '1px solid #334155', borderRadius: 6, padding: '8px 10px', color: '#f1f5f9', fontSize: 14, outline: 'none', marginBottom: 0 },
  select: { width: '100%', background: '#0f172a', border: '1px solid #334155', borderRadius: 6, padding: '8px 10px', color: '#f1f5f9', fontSize: 14 },
  btn: { background: '#3b82f6', border: 'none', borderRadius: 6, padding: '9px 18px', color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer' },
  smBtn: { background: 'none', border: '1px solid #334155', borderRadius: 6, padding: '4px 10px', color: '#cbd5e1', fontSize: 12, cursor: 'pointer' },
  clearBtn: { background: 'none', border: '1px solid #fca5a5', borderRadius: 6, padding: '4px 12px', color: '#ef4444', fontSize: 13, cursor: 'pointer' },
  err: { fontSize: 13, color: '#ef4444', marginBottom: 4 },
  liveBar: { background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 14px', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  presetRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #1e293b' },
  toast: { position: 'fixed', top: 16, right: 16, background: '#1e293b', border: '1px solid #3b82f6', borderRadius: 8, padding: '10px 16px', fontSize: 14, color: '#60a5fa', zIndex: 999 },
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [mode, setMode] = useState(null)
  useEffect(() => setMode(window.location.hash === '#overlay' ? 'overlay' : 'control'), [])
  if (!mode) return null
  return mode === 'overlay' ? <Overlay /> : <ControlPanel />
}
