import { useState, useEffect, useRef, useCallback } from 'react'

const MOD_PASSWORD = 'streammod2024'
const FIREBASE_URL = 'https://overlay-7162f-default-rtdb.europe-west1.firebasedatabase.app'

const DEFAULT_STATE = {
  active: false, type: null, url: '', label: '',
  volume: 80, loop: false, fit: 'contain', startAt: 0,
  // Video box position/size as % of stream canvas (1920x1080)
  boxX: 25, boxY: 25, boxW: 50, boxH: 50,
  timestamp: 0,
}

function parseYouTubeId(url) {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([a-zA-Z0-9_-]{11})/)
  return m ? m[1] : null
}

function detectType(url) {
  if (!url) return null
  if (parseYouTubeId(url) || /\.(mp4|webm|ogg|mov|avi|mkv)(\?|$)/i.test(url)) return 'video'
  if (/\.(jpe?g|png|gif|webp|svg|avif|bmp|tiff?)(\?|$)/i.test(url)) return 'image'
  return null
}

function parseTimestamp(str) {
  if (!str || !str.trim()) return 0
  const parts = str.trim().split(':').map(Number)
  if (parts.some(isNaN)) return 0
  if (parts.length === 1) return parts[0]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] * 3600 + parts[1] * 60 + parts[2]
}

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

// ─── Overlay (runs in Tauri app at #overlay) ──────────────────────────────────
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

  // YouTube: poll the iframe via postMessage every 2s to check if ended
  const iframeRef = useRef(null)
  const ytPollRef = useRef(null)
  useEffect(() => {
    if (ytPollRef.current) clearInterval(ytPollRef.current)
    if (!state.active || !parseYouTubeId(state.url || '')) return
    // Send a listen request to the YT iframe API
    const sendListen = () => {
      if (!iframeRef.current) return
      try {
        iframeRef.current.contentWindow.postMessage(
          JSON.stringify({ event: 'listening', id: 1 }), '*'
        )
      } catch (_) {}
    }
    // Poll by requesting player state every 2s
    ytPollRef.current = setInterval(() => {
      if (!iframeRef.current) return
      try {
        iframeRef.current.contentWindow.postMessage(
          JSON.stringify({ event: 'command', func: 'getPlayerState', args: [] }), '*'
        )
      } catch (_) {}
    }, 2000)
    setTimeout(sendListen, 1000)
    return () => clearInterval(ytPollRef.current)
  }, [state.active, state.url, state.timestamp])

  useEffect(() => {
    const handler = (e) => {
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
        // YT state 0 = ended, -1 = unstarted, 1 = playing, 2 = paused, 3 = buffering
        if (data?.event === 'onStateChange' && data?.info === 0) {
          if (!state.loop) autoClear()
        }
        // Also handle infoDelivery which some YT builds use
        if (data?.event === 'infoDelivery' && data?.info?.playerState === 0) {
          if (!state.loop) autoClear()
        }
      } catch (_) {}
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [autoClear, state.loop])

  const ytId = state.url ? parseYouTubeId(state.url) : null
  const startSecs = state.startAt || 0

  const boxStyle = {
    position: 'absolute',
    left: `${state.boxX}%`,
    top: `${state.boxY}%`,
    width: `${state.boxW}%`,
    height: `${state.boxH}%`,
    overflow: 'hidden',
  }

  return (
    <div style={{ width: '100vw', height: '100vh', background: 'transparent', position: 'relative', overflow: 'hidden' }}>
      {state.active && (
        <div style={boxStyle}>
          {state.type === 'image' && (
            <img key={state.timestamp} src={state.url} alt=""
              style={{ width: '100%', height: '100%', objectFit: state.fit || 'contain' }} />
          )}
          {state.type === 'video' && ytId && (
            <div style={{ width: '100%', height: '100%', overflow: 'hidden', position: 'relative' }}>
              <iframe key={state.timestamp}
                ref={iframeRef}
                src={`https://www.youtube.com/embed/${ytId}?autoplay=1&loop=${state.loop ? 1 : 0}&playlist=${ytId}&enablejsapi=1&start=${startSecs}&origin=${encodeURIComponent(window.location.origin)}&rel=0`}
                allow="autoplay; fullscreen"
                style={{ width: '100%', height: 'calc(100% + 80px)', border: 'none', marginBottom: '-80px' }} />
            </div>
          )}
          {state.type === 'video' && !ytId && (
            <video key={state.timestamp} src={state.url} autoPlay loop={state.loop}
              onEnded={() => { if (!state.loop) autoClear() }}
              onLoadedMetadata={e => { if (startSecs > 0) e.target.currentTime = startSecs }}
              style={{ width: '100%', height: '100%', objectFit: state.fit || 'contain' }} />
          )}
        </div>
      )}
    </div>
  )
}

// ─── Draggable/resizable box in preview ───────────────────────────────────────
function PreviewBox({ box, onChange }) {
  const ref = useRef()
  const drag = useRef(null)

  const onMouseDown = (e, mode) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = ref.current.parentElement.getBoundingClientRect()
    drag.current = {
      mode,
      startX: e.clientX, startY: e.clientY,
      origBox: { ...box },
      parentW: rect.width, parentH: rect.height,
      parentLeft: rect.left, parentTop: rect.top,
    }
  }

  useEffect(() => {
    const onMove = (e) => {
      if (!drag.current) return
      const { mode, startX, startY, origBox, parentW, parentH } = drag.current
      const dx = (e.clientX - startX) / parentW * 100
      const dy = (e.clientY - startY) / parentH * 100

      let { boxX, boxY, boxW, boxH } = origBox
      if (mode === 'move') {
        boxX = Math.max(0, Math.min(100 - boxW, origBox.boxX + dx))
        boxY = Math.max(0, Math.min(100 - boxH, origBox.boxY + dy))
      } else {
        if (mode.includes('e')) boxW = Math.max(5, Math.min(100 - origBox.boxX, origBox.boxW + dx))
        if (mode.includes('s')) boxH = Math.max(5, Math.min(100 - origBox.boxY, origBox.boxH + dy))
        if (mode.includes('w')) {
          const newW = Math.max(5, origBox.boxW - dx)
          boxX = origBox.boxX + origBox.boxW - newW
          boxW = newW
        }
        if (mode.includes('n')) {
          const newH = Math.max(5, origBox.boxH - dy)
          boxY = origBox.boxY + origBox.boxH - newH
          boxH = newH
        }
      }
      onChange({ boxX, boxY, boxW, boxH })
    }
    const onUp = () => { drag.current = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [onChange])

  const handle = (cursor, mode, style) => (
    <div onMouseDown={e => onMouseDown(e, mode)}
      style={{ position: 'absolute', cursor, zIndex: 10, ...style }} />
  )
  const hs = 10 // handle size

  return (
    <div ref={ref} style={{
      position: 'absolute',
      left: `${box.boxX}%`, top: `${box.boxY}%`,
      width: `${box.boxW}%`, height: `${box.boxH}%`,
      border: '2px solid #3b82f6',
      boxSizing: 'border-box',
      background: 'rgba(59,130,246,0.15)',
    }}>
      {/* Move area */}
      <div onMouseDown={e => onMouseDown(e, 'move')} style={{
        position: 'absolute', inset: hs, cursor: 'move',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{ fontSize: 11, color: '#fff', background: 'rgba(0,0,0,0.5)', padding: '2px 6px', borderRadius: 4, pointerEvents: 'none', userSelect: 'none' }}>
          drag to move
        </span>
      </div>
      {/* Edge handles */}
      {handle('ns-resize', 'n',  { top: 0, left: hs, right: hs, height: hs })}
      {handle('ns-resize', 's',  { bottom: 0, left: hs, right: hs, height: hs })}
      {handle('ew-resize', 'w',  { left: 0, top: hs, bottom: hs, width: hs })}
      {handle('ew-resize', 'e',  { right: 0, top: hs, bottom: hs, width: hs })}
      {/* Corner handles */}
      {handle('nwse-resize', 'nw', { top: 0, left: 0, width: hs, height: hs })}
      {handle('nesw-resize', 'ne', { top: 0, right: 0, width: hs, height: hs })}
      {handle('nesw-resize', 'sw', { bottom: 0, left: 0, width: hs, height: hs })}
      {handle('nwse-resize', 'se', { bottom: 0, right: 0, width: hs, height: hs })}
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
  const [startAt, setStartAt] = useState('')
  const [urlErr, setUrlErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')
  const [liveState, setLiveState] = useState(DEFAULT_STATE)
  const [presets, setPresets] = useState([])
  const [presetName, setPresetName] = useState('')
  const [box, setBox] = useState({ boxX: 25, boxY: 25, boxW: 50, boxH: 50 })
  const boxPushTimer = useRef(null)

  useEffect(() => {
    const saved = localStorage.getItem('stream-mod-presets')
    if (saved) setPresets(JSON.parse(saved))
  }, [])

  useEffect(() => {
    if (!authed) return
    const poll = async () => {
      try {
        const d = await fbGet()
        if (d) {
          setLiveState(d)
          setBox({ boxX: d.boxX ?? 25, boxY: d.boxY ?? 25, boxW: d.boxW ?? 50, boxH: d.boxH ?? 50 })
        }
      } catch (_) {}
    }
    poll()
    const id = setInterval(poll, 1000)
    return () => clearInterval(id)
  }, [authed])

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2500) }

  const push = async (patch) => {
    setSaving(true)
    const next = { ...liveState, ...box, ...patch, timestamp: Date.now() }
    try {
      await fbSet(next)
      setLiveState(next)
      showToast(patch.active === false ? 'Overlay cleared' : 'Overlay updated')
    } catch { showToast('Firebase error') }
    setSaving(false)
  }

  // Push box position debounced while dragging
  const handleBoxChange = useCallback((newBox) => {
    setBox(newBox)
    if (boxPushTimer.current) clearTimeout(boxPushTimer.current)
    boxPushTimer.current = setTimeout(async () => {
      try {
        const current = await fbGet()
        if (current) await fbSet({ ...current, ...newBox, timestamp: Date.now() })
      } catch (_) {}
    }, 150)
  }, [])

  const handleSend = async () => {
    if (!url.trim()) { setUrlErr('Enter a URL'); return }
    const type = detectType(url.trim())
    if (!type) { setUrlErr('Must be a YouTube link, video or image URL'); return }
    setUrlErr('')
    await push({ active: true, type, url: url.trim(), label, volume, loop, fit, startAt: parseTimestamp(startAt), ...box })
  }

  const handleClear = () => push({ ...DEFAULT_STATE, active: false, ...box })

  const savePreset = () => {
    if (!url.trim() || !presetName.trim()) return
    const p = { name: presetName, url, label, volume, loop, fit, startAt }
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
    url: p.url, label: p.label, volume: p.volume,
    loop: p.loop, fit: p.fit, startAt: parseTimestamp(p.startAt || ''), ...box,
  })

  const isVideoUrl = (u) => u && (parseYouTubeId(u) || /\.(mp4|webm|ogg|mov)(\?|$)/i.test(u))

  if (!authed) {
    return (
      <div style={s.loginWrap}>
        <div style={s.loginBox}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🎬</div>
          <h2 style={s.loginTitle}>Mod control panel</h2>
          <p style={s.loginSub}>Enter the mod password to continue</p>
          <input type="password" placeholder="Password" value={pw}
            onChange={e => { setPw(e.target.value); setPwErr('') }}
            onKeyDown={e => { if (e.key === 'Enter') pw === MOD_PASSWORD ? setAuthed(true) : setPwErr('Wrong password') }}
            style={s.input} />
          {pwErr && <div style={s.err}>{pwErr}</div>}
          <button style={{ ...s.btn, width: '100%', marginTop: 8 }}
            onClick={() => pw === MOD_PASSWORD ? setAuthed(true) : setPwErr('Wrong password')}>
            Sign in
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={s.wrap}>
      {toast && <div style={s.toast}>{toast}</div>}
      <div style={s.inner}>

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

        {/* Stream preview with draggable box */}
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <label style={{ ...s.label, marginBottom: 0 }}>Stream preview — drag to position</label>
            <span style={{ fontSize: 11, color: '#64748b' }}>
              {Math.round(box.boxX)}% {Math.round(box.boxY)}% · {Math.round(box.boxW)}×{Math.round(box.boxH)}%
            </span>
          </div>
          <div style={{ position: 'relative', width: '100%', paddingBottom: '56.25%', borderRadius: 8, overflow: 'hidden', background: '#000' }}>
            {/* Twitch stream embed */}
            <iframe
              src="https://player.twitch.tv/?channel=beccahtw&parent=dergummibaer.github.io&muted=true"
              allowFullScreen
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' }}
            />
            {/* Draggable overlay box */}
            <PreviewBox box={box} onChange={handleBoxChange} />
          </div>
        </div>

        {liveState.active && (
          <div style={s.liveBar}>
            <div>
              <span style={{ fontWeight: 500, color: '#15803d', fontSize: 14 }}>
                {liveState.label || liveState.url.slice(0, 55)}
              </span>
              <span style={{ fontSize: 12, color: '#16a34a', marginLeft: 8, opacity: 0.8 }}>
                {liveState.type} · {liveState.fit}
                {liveState.startAt > 0 && ` · @${liveState.startAt}s`}
                {liveState.loop && ' · looping'}
              </span>
            </div>
            <button style={s.clearBtn} onClick={handleClear}>Clear</button>
          </div>
        )}

        <div style={s.card}>
          <label style={s.label}>URL</label>
          <input type="url" placeholder="YouTube link, .mp4, .webm, .jpg, .png, .gif…"
            value={url} onChange={e => { setUrl(e.target.value); setUrlErr('') }}
            style={{ ...s.input, marginBottom: urlErr ? 4 : 12 }} />
          {urlErr && <div style={{ ...s.err, marginBottom: 8 }}>{urlErr}</div>}

          <label style={s.label}>Label (optional)</label>
          <input type="text" placeholder="e.g. Raid gif, hype clip…"
            value={label} onChange={e => setLabel(e.target.value)}
            style={{ ...s.input, marginBottom: 12 }} />

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
              <input type="range" min={0} max={100} step={1} value={volume}
                onChange={e => setVolume(+e.target.value)}
                style={{ width: '100%', marginTop: 6 }} />
            </div>
          </div>

          {isVideoUrl(url) && (
            <div style={{ marginBottom: 12 }}>
              <label style={s.label}>Start at (optional)</label>
              <input type="text" placeholder="e.g. 1:23 or 83"
                value={startAt} onChange={e => setStartAt(e.target.value)}
                style={{ ...s.input, width: 180 }} />
            </div>
          )}

          <label style={{ ...s.label, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 16 }}>
            <input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)} />
            Loop video
          </label>

          <button style={{ ...s.btn, width: '100%' }} onClick={handleSend} disabled={saving}>
            {saving ? 'Sending…' : 'Send to overlay'}
          </button>
        </div>

        <div style={s.card}>
          <h3 style={s.h3}>Saved presets</h3>
          {presets.length === 0 && (
            <p style={{ ...s.sub, marginBottom: 12 }}>No presets yet.</p>
          )}
          {presets.map(p => (
            <div key={p.name} style={s.presetRow}>
              <div style={{ minWidth: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{p.name}</span>
                <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 8 }}>
                  {p.url.slice(0, 38)}{p.url.length > 38 ? '…' : ''}
                  {p.startAt && ` · ${p.startAt}`}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button style={s.smBtn} onClick={() => {
                  setUrl(p.url); setLabel(p.label); setVolume(p.volume)
                  setLoop(p.loop); setFit(p.fit); setStartAt(p.startAt || '')
                }}>Load</button>
                <button style={s.smBtn} onClick={() => sendPreset(p)}>Send</button>
                <button style={{ ...s.smBtn, color: '#ef4444', borderColor: '#fca5a5' }}
                  onClick={() => deletePreset(p.name)}>✕</button>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <input type="text" placeholder="Preset name…" value={presetName}
              onChange={e => setPresetName(e.target.value)}
              style={{ ...s.input, flex: 1, marginBottom: 0 }} />
            <button style={s.btn} onClick={savePreset}>Save</button>
          </div>
        </div>

        <button style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: 12, cursor: 'pointer', marginTop: 8 }}
          onClick={() => setAuthed(false)}>Sign out</button>
      </div>
    </div>
  )
}

const s = {
  loginWrap: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a', fontFamily: 'system-ui, sans-serif' },
  loginBox: { background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: '2rem 2.5rem', width: 320, textAlign: 'center', color: '#f1f5f9' },
  loginTitle: { margin: '0 0 4px', fontSize: 18, fontWeight: 500, color: '#f1f5f9' },
  loginSub: { margin: '0 0 1.25rem', fontSize: 13, color: '#94a3b8' },
  wrap: { minHeight: '100vh', background: '#0f172a', padding: '1.5rem', boxSizing: 'border-box', fontFamily: 'system-ui, sans-serif', color: '#f1f5f9' },
  inner: { maxWidth: 700, margin: '0 auto' },
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
  presetRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #334155' },
  toast: { position: 'fixed', top: 16, right: 16, background: '#1e293b', border: '1px solid #3b82f6', borderRadius: 8, padding: '10px 16px', fontSize: 14, color: '#60a5fa', zIndex: 999 },
}

export default function App() {
  const [mode, setMode] = useState(null)
  useEffect(() => setMode(window.location.hash === '#overlay' ? 'overlay' : 'control'), [])
  if (!mode) return null
  return mode === 'overlay' ? <Overlay /> : <ControlPanel />
}
