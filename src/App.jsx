import { useState, useEffect, useRef, useCallback } from 'react'

const MOD_PASSWORD = 'streammod2024'
const FIREBASE_URL = 'https://overlay-7162f-default-rtdb.europe-west1.firebasedatabase.app'

const DEFAULT_ACTIVE = {
  active: false, type: null, url: '', label: '', modName: '',
  volume: 80, loop: false, fit: 'contain', startAt: 0, endAt: 0,
  boxX: 25, boxY: 25, boxW: 50, boxH: 50, timestamp: 0,
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

function formatTime(ts) {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

async function fbGet(path = '') {
  const res = await fetch(`${FIREBASE_URL}${path}.json`)
  if (!res.ok) throw new Error('Firebase read failed')
  return await res.json()
}

async function fbSet(path, data) {
  const res = await fetch(`${FIREBASE_URL}${path}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Firebase write failed')
}

async function fbPush(path, data) {
  const res = await fetch(`${FIREBASE_URL}${path}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Firebase push failed')
  return await res.json()
}

async function fbDelete(path) {
  await fetch(`${FIREBASE_URL}${path}.json`, { method: 'DELETE' })
}

// ─── Overlay ──────────────────────────────────────────────────────────────────
function Overlay() {
  const [active, setActive] = useState(DEFAULT_ACTIVE)
  const lastTs = useRef(0)
  const iframeRef = useRef(null)

  useEffect(() => {
    const poll = async () => {
      try {
        const data = await fbGet('/active')
        if (data && data.timestamp !== lastTs.current) {
          lastTs.current = data.timestamp
          setActive(data)
        }
      } catch (_) {}
    }
    poll()
    const id = setInterval(poll, 800)
    return () => clearInterval(id)
  }, [])

  const advanceQueue = useCallback(async () => {
    try {
      const queue = await fbGet('/queue')
      const items = queue ? Object.entries(queue).sort((a, b) => a[1].addedAt - b[1].addedAt) : []
      if (items.length > 0) {
        const [key, next] = items[0]
        const nextActive = { ...next, active: true, timestamp: Date.now() }
        await fbSet('/active', nextActive)
        await fbDelete(`/queue/${key}`)
        // Add to history
        await fbPush('/history', { ...next, playedAt: Date.now() })
        lastTs.current = nextActive.timestamp
        setActive(nextActive)
      } else {
        const cleared = { ...DEFAULT_ACTIVE, timestamp: Date.now() }
        await fbSet('/active', cleared)
        lastTs.current = cleared.timestamp
        setActive(cleared)
      }
    } catch (_) {}
  }, [])

  // YouTube ad blocking
  useEffect(() => {
    if (!active.active || !parseYouTubeId(active.url || '')) return
    const tryBlock = () => {
      try {
        const iframe = iframeRef.current
        if (!iframe) return
        const doc = iframe.contentDocument || iframe.contentWindow?.document
        if (!doc) return
        const skip = doc.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern')
        if (skip) skip.click()
        const adVid = doc.querySelector('.ad-showing video')
        if (adVid && !adVid.paused) { adVid.muted = true; if (adVid.duration) adVid.currentTime = adVid.duration }
        const adOverlay = doc.querySelector('.ytp-ad-player-overlay-layout')
        if (adOverlay) adOverlay.remove()
      } catch (_) {}
    }
    const id = setInterval(tryBlock, 200)
    return () => clearInterval(id)
  }, [active.active, active.url, active.timestamp])

  // YouTube ended detection
  useEffect(() => {
    const handler = (e) => {
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
        if ((data?.event === 'onStateChange' && data?.info === 0) ||
            (data?.event === 'infoDelivery' && data?.info?.playerState === 0)) {
          if (!active.loop) advanceQueue()
        }
      } catch (_) {}
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [advanceQueue, active.loop])

  const ytId = active.url ? parseYouTubeId(active.url) : null
  const startSecs = active.startAt || 0
  const endSecs = active.endAt || 0

  const boxStyle = {
    position: 'absolute',
    left: `${active.boxX}%`, top: `${active.boxY}%`,
    width: `${active.boxW}%`, height: `${active.boxH}%`,
    overflow: 'hidden',
  }

  return (
    <div style={{ width: '100vw', height: '100vh', background: 'transparent', position: 'relative', overflow: 'hidden' }}>
      {active.active && (
        <div style={boxStyle}>
          {active.type === 'image' && (
            <img key={active.timestamp} src={active.url} alt=""
              style={{ width: '100%', height: '100%', objectFit: active.fit || 'contain' }} />
          )}
          {active.type === 'video' && ytId && (
            <div style={{ width: '100%', height: '100%', overflow: 'hidden', position: 'relative' }}>
              <iframe key={active.timestamp} ref={iframeRef}
                src={`https://www.youtube.com/embed/${ytId}?autoplay=1&loop=${active.loop ? 1 : 0}&playlist=${ytId}&enablejsapi=1&start=${startSecs}${endSecs > 0 ? `&end=${endSecs}` : ''}&origin=${encodeURIComponent(window.location.origin)}&rel=0`}
                allow="autoplay; fullscreen"
                style={{ width: '100%', height: 'calc(100% + 80px)', border: 'none', marginBottom: '-80px' }} />
            </div>
          )}
          {active.type === 'video' && !ytId && (
            <video key={active.timestamp} src={active.url} autoPlay loop={active.loop}
              onEnded={() => { if (!active.loop) advanceQueue() }}
              onLoadedMetadata={e => { if (startSecs > 0) e.target.currentTime = startSecs }}
              onTimeUpdate={e => { if (endSecs > 0 && e.target.currentTime >= endSecs) { e.target.pause(); if (!active.loop) advanceQueue() } }}
              style={{ width: '100%', height: '100%', objectFit: active.fit || 'contain' }} />
          )}
        </div>
      )}
    </div>
  )
}

// ─── Draggable/resizable preview box ─────────────────────────────────────────
function PreviewBox({ box, onChange }) {
  const ref = useRef()
  const drag = useRef(null)

  const onMouseDown = (e, mode) => {
    e.preventDefault(); e.stopPropagation()
    const rect = ref.current.parentElement.getBoundingClientRect()
    drag.current = { mode, startX: e.clientX, startY: e.clientY, origBox: { ...box }, parentW: rect.width, parentH: rect.height }
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
        if (mode.includes('w')) { const nw = Math.max(5, origBox.boxW - dx); boxX = origBox.boxX + origBox.boxW - nw; boxW = nw }
        if (mode.includes('n')) { const nh = Math.max(5, origBox.boxH - dy); boxY = origBox.boxY + origBox.boxH - nh; boxH = nh }
      }
      onChange({ boxX, boxY, boxW, boxH })
    }
    const onUp = () => { drag.current = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [onChange])

  const hs = 10
  const handle = (cursor, mode, style) => (
    <div onMouseDown={e => onMouseDown(e, mode)} style={{ position: 'absolute', cursor, zIndex: 10, ...style }} />
  )

  return (
    <div ref={ref} style={{
      position: 'absolute', left: `${box.boxX}%`, top: `${box.boxY}%`,
      width: `${box.boxW}%`, height: `${box.boxH}%`,
      border: '2px solid #3b82f6', boxSizing: 'border-box', background: 'rgba(59,130,246,0.15)',
    }}>
      <div onMouseDown={e => onMouseDown(e, 'move')} style={{ position: 'absolute', inset: hs, cursor: 'move', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: 11, color: '#fff', background: 'rgba(0,0,0,0.5)', padding: '2px 6px', borderRadius: 4, pointerEvents: 'none', userSelect: 'none' }}>drag to move</span>
      </div>
      {handle('ns-resize', 'n', { top: 0, left: hs, right: hs, height: hs })}
      {handle('ns-resize', 's', { bottom: 0, left: hs, right: hs, height: hs })}
      {handle('ew-resize', 'w', { left: 0, top: hs, bottom: hs, width: hs })}
      {handle('ew-resize', 'e', { right: 0, top: hs, bottom: hs, width: hs })}
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
  const [modName, setModName] = useState('')
  const [pwErr, setPwErr] = useState('')
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [volume, setVolume] = useState(80)
  const [loop, setLoop] = useState(false)
  const [fit, setFit] = useState('contain')
  const [startAt, setStartAt] = useState('')
  const [endAt, setEndAt] = useState('')
  const [urlErr, setUrlErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')
  const [activeState, setActiveState] = useState(DEFAULT_ACTIVE)
  const [queue, setQueue] = useState([])
  const [history, setHistory] = useState([])
  const [presets, setPresets] = useState([])
  const [presetName, setPresetName] = useState('')
  const [box, setBox] = useState({ boxX: 25, boxY: 25, boxW: 50, boxH: 50 })
  const [tab, setTab] = useState('send') // send | queue | history
  const boxPushTimer = useRef(null)

  useEffect(() => {
    const saved = localStorage.getItem('stream-mod-presets')
    if (saved) setPresets(JSON.parse(saved))
    const savedName = localStorage.getItem('stream-mod-name')
    if (savedName) setModName(savedName)
  }, [])

  useEffect(() => {
    if (!authed) return
    const poll = async () => {
      try {
        const [act, q, hist] = await Promise.all([
          fbGet('/active'),
          fbGet('/queue'),
          fbGet('/history'),
        ])
        if (act) {
          setActiveState(act)
          setBox({ boxX: act.boxX ?? 25, boxY: act.boxY ?? 25, boxW: act.boxW ?? 50, boxH: act.boxH ?? 50 })
        }
        setQueue(q ? Object.entries(q).sort((a, b) => a[1].addedAt - b[1].addedAt).map(([k, v]) => ({ key: k, ...v })) : [])
        setHistory(hist ? Object.entries(hist).sort((a, b) => b[1].playedAt - a[1].playedAt).slice(0, 30).map(([k, v]) => ({ key: k, ...v })) : [])
      } catch (_) {}
    }
    poll()
    const id = setInterval(poll, 1500)
    return () => clearInterval(id)
  }, [authed])

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2500) }

  const buildItem = () => ({
    type: detectType(url.trim()),
    url: url.trim(), label, modName,
    volume, loop, fit,
    startAt: parseTimestamp(startAt),
    endAt: parseTimestamp(endAt),
    ...box,
  })

  const handleSendNow = async () => {
    if (!url.trim()) { setUrlErr('Enter a URL'); return }
    const type = detectType(url.trim())
    if (!type) { setUrlErr('Must be a YouTube link, video or image URL'); return }
    setUrlErr('')
    setSaving(true)
    try {
      const item = { ...buildItem(), type, active: true, timestamp: Date.now() }
      await fbSet('/active', item)
      await fbPush('/history', { ...item, playedAt: Date.now() })
      setActiveState(item)
      showToast('Sent to overlay')
    } catch { showToast('Firebase error') }
    setSaving(false)
  }

  const handleAddToQueue = async () => {
    if (!url.trim()) { setUrlErr('Enter a URL'); return }
    const type = detectType(url.trim())
    if (!type) { setUrlErr('Must be a YouTube link, video or image URL'); return }
    setUrlErr('')
    setSaving(true)
    try {
      await fbPush('/queue', { ...buildItem(), type, addedAt: Date.now() })
      showToast('Added to queue')
      // If nothing active, play immediately
      const act = await fbGet('/active')
      if (!act || !act.active) {
        const q = await fbGet('/queue')
        const items = q ? Object.entries(q).sort((a, b) => a[1].addedAt - b[1].addedAt) : []
        if (items.length > 0) {
          const [key, next] = items[0]
          const nextActive = { ...next, active: true, timestamp: Date.now() }
          await fbSet('/active', nextActive)
          await fbDelete(`/queue/${key}`)
          await fbPush('/history', { ...next, playedAt: Date.now() })
        }
      }
    } catch { showToast('Firebase error') }
    setSaving(false)
  }

  const handleClear = async () => {
    setSaving(true)
    try {
      await fbSet('/active', { ...DEFAULT_ACTIVE, timestamp: Date.now() })
      showToast('Overlay cleared')
    } catch { showToast('Firebase error') }
    setSaving(false)
  }

  const removeFromQueue = async (key) => {
    try { await fbDelete(`/queue/${key}`); showToast('Removed from queue') } catch (_) {}
  }

  const clearHistory = async () => {
    try { await fbDelete('/history'); setHistory([]); showToast('History cleared') } catch (_) {}
  }

  const handleBoxChange = useCallback((newBox) => {
    setBox(newBox)
    if (boxPushTimer.current) clearTimeout(boxPushTimer.current)
    boxPushTimer.current = setTimeout(async () => {
      try {
        const current = await fbGet('/active')
        if (current) await fbSet('/active', { ...current, ...newBox, timestamp: Date.now() })
      } catch (_) {}
    }, 150)
  }, [])

  const savePreset = () => {
    if (!url.trim() || !presetName.trim()) return
    const p = { name: presetName, url, label, volume, loop, fit, startAt, endAt }
    const updated = [...presets.filter(x => x.name !== presetName), p]
    setPresets(updated)
    localStorage.setItem('stream-mod-presets', JSON.stringify(updated))
    setPresetName('')
    showToast('Preset saved')
  }

  const loadPreset = (p) => {
    setUrl(p.url); setLabel(p.label); setVolume(p.volume)
    setLoop(p.loop); setFit(p.fit); setStartAt(p.startAt || ''); setEndAt(p.endAt || '')
  }

  const isVideoUrl = (u) => u && (parseYouTubeId(u) || /\.(mp4|webm|ogg|mov)(\?|$)/i.test(u))

  if (!authed) {
    return (
      <div style={s.loginWrap}>
        <div style={s.loginBox}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🎬</div>
          <h2 style={s.loginTitle}>Mod control panel</h2>
          <p style={s.loginSub}>Enter your name and the mod password</p>
          <input type="text" placeholder="Your name" value={modName}
            onChange={e => setModName(e.target.value)}
            style={{ ...s.input, marginBottom: 8 }} />
          <input type="password" placeholder="Password" value={pw}
            onChange={e => { setPw(e.target.value); setPwErr('') }}
            onKeyDown={e => {
              if (e.key !== 'Enter') return
              if (!modName.trim()) { setPwErr('Enter your name'); return }
              if (pw === MOD_PASSWORD) {
                localStorage.setItem('stream-mod-name', modName.trim())
                setAuthed(true)
              } else setPwErr('Wrong password')
            }}
            style={{ ...s.input, marginBottom: 8 }} />
          {pwErr && <div style={s.err}>{pwErr}</div>}
          <button style={{ ...s.btn, width: '100%', marginTop: 8 }} onClick={() => {
            if (!modName.trim()) { setPwErr('Enter your name'); return }
            if (pw === MOD_PASSWORD) {
              localStorage.setItem('stream-mod-name', modName.trim())
              setAuthed(true)
            } else setPwErr('Wrong password')
          }}>Sign in</button>
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
            <p style={s.sub}>Signed in as <strong style={{ color: '#cbd5e1' }}>{modName}</strong></p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ ...s.dot, background: activeState.active ? '#22c55e' : '#6b7280' }} />
            <span style={s.sub}>{activeState.active ? `Live · ${activeState.type}${activeState.modName ? ` · ${activeState.modName}` : ''}` : 'No overlay'}</span>
          </div>
        </div>

        {/* Stream preview */}
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <label style={{ ...s.label, marginBottom: 0 }}>Stream preview — drag to position</label>
            <span style={{ fontSize: 11, color: '#64748b' }}>
              {Math.round(box.boxX)}% {Math.round(box.boxY)}% · {Math.round(box.boxW)}×{Math.round(box.boxH)}%
            </span>
          </div>
          <div style={{ position: 'relative', width: '100%', paddingBottom: '56.25%', borderRadius: 8, overflow: 'hidden', background: '#000' }}>
            <iframe
              src="https://player.twitch.tv/?channel=beccahtw&parent=dergummibaer.github.io&muted=true"
              allowFullScreen
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' }} />
            <PreviewBox box={box} onChange={handleBoxChange} />
          </div>
        </div>

        {/* Live bar */}
        {activeState.active && (
          <div style={s.liveBar}>
            <div style={{ minWidth: 0 }}>
              <span style={{ fontWeight: 500, color: '#15803d', fontSize: 14 }}>
                {activeState.label || activeState.url.slice(0, 50)}
              </span>
              <span style={{ fontSize: 12, color: '#16a34a', marginLeft: 8, opacity: 0.8 }}>
                {activeState.type} · sent by {activeState.modName || 'unknown'}
                {activeState.startAt > 0 && ` · @${activeState.startAt}s`}
                {activeState.endAt > 0 && ` → ${activeState.endAt}s`}
              </span>
            </div>
            <button style={s.clearBtn} onClick={handleClear}>Clear</button>
          </div>
        )}

        {/* Queue badge */}
        {queue.length > 0 && (
          <div style={{ ...s.liveBar, background: '#1e1b4b', borderColor: '#4f46e5' }}>
            <span style={{ fontSize: 13, color: '#a5b4fc' }}>
              {queue.length} item{queue.length > 1 ? 's' : ''} in queue — next: <strong>{queue[0].label || queue[0].url.slice(0, 40)}</strong>
            </span>
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
          {['send', 'queue', 'history'].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              ...s.tabBtn,
              background: tab === t ? '#3b82f6' : 'none',
              color: tab === t ? '#fff' : '#94a3b8',
              borderColor: tab === t ? '#3b82f6' : '#334155',
            }}>
              {t === 'send' ? 'Send' : t === 'queue' ? `Queue ${queue.length > 0 ? `(${queue.length})` : ''}` : 'History'}
            </button>
          ))}
        </div>

        {/* Send tab */}
        {tab === 'send' && (
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
                  <option value="cover">Cover (fill)</option>
                  <option value="fill">Stretch</option>
                </select>
              </div>
              <div>
                <label style={s.label}>Volume — {volume}%</label>
                <input type="range" min={0} max={100} value={volume}
                  onChange={e => setVolume(+e.target.value)}
                  style={{ width: '100%', marginTop: 6 }} />
              </div>
            </div>

            {isVideoUrl(url) && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={s.label}>Start at</label>
                  <input type="text" placeholder="e.g. 1:23" value={startAt}
                    onChange={e => setStartAt(e.target.value)} style={s.input} />
                </div>
                <div>
                  <label style={s.label}>End at</label>
                  <input type="text" placeholder="e.g. 2:45" value={endAt}
                    onChange={e => setEndAt(e.target.value)} style={s.input} />
                </div>
              </div>
            )}

            <label style={{ ...s.label, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 16 }}>
              <input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)} />
              Loop video
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <button style={{ ...s.btn, background: '#3b82f6' }} onClick={handleSendNow} disabled={saving}>
                {saving ? 'Sending…' : '▶ Send now'}
              </button>
              <button style={{ ...s.btn, background: '#4f46e5' }} onClick={handleAddToQueue} disabled={saving}>
                + Add to queue
              </button>
            </div>

            {/* Presets */}
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #334155' }}>
              <h3 style={{ ...s.h3, marginBottom: 10 }}>Presets</h3>
              {presets.length === 0 && <p style={{ ...s.sub, marginBottom: 10 }}>No presets yet.</p>}
              {presets.map(p => (
                <div key={p.name} style={s.presetRow}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button style={s.smBtn} onClick={() => loadPreset(p)}>Load</button>
                    <button style={s.smBtn} onClick={() => { loadPreset(p); setUrl(p.url) }}>Load</button>
                    <button style={{ ...s.smBtn, color: '#ef4444', borderColor: '#fca5a5' }}
                      onClick={() => { const u = presets.filter(x => x.name !== p.name); setPresets(u); localStorage.setItem('stream-mod-presets', JSON.stringify(u)) }}>✕</button>
                  </div>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input type="text" placeholder="Preset name…" value={presetName}
                  onChange={e => setPresetName(e.target.value)}
                  style={{ ...s.input, flex: 1, marginBottom: 0 }} />
                <button style={s.btn} onClick={savePreset}>Save</button>
              </div>
            </div>
          </div>
        )}

        {/* Queue tab */}
        {tab === 'queue' && (
          <div style={s.card}>
            <h3 style={s.h3}>Queue</h3>
            {queue.length === 0 && <p style={s.sub}>Queue is empty.</p>}
            {queue.map((item, i) => (
              <div key={item.key} style={s.presetRow}>
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontSize: 12, color: '#64748b', marginRight: 8 }}>#{i + 1}</span>
                  <span style={{ fontSize: 14, fontWeight: 500 }}>{item.label || item.url.slice(0, 45)}</span>
                  <span style={{ fontSize: 12, color: '#64748b', marginLeft: 8 }}>{item.modName}</span>
                </div>
                <button style={{ ...s.smBtn, color: '#ef4444', borderColor: '#fca5a5' }}
                  onClick={() => removeFromQueue(item.key)}>✕</button>
              </div>
            ))}
          </div>
        )}

        {/* History tab */}
        {tab === 'history' && (
          <div style={s.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ ...s.h3, marginBottom: 0 }}>History</h3>
              {history.length > 0 && (
                <button style={{ ...s.smBtn, fontSize: 12 }} onClick={clearHistory}>Clear all</button>
              )}
            </div>
            {history.length === 0 && <p style={s.sub}>Nothing played yet.</p>}
            {history.map(item => (
              <div key={item.key} style={s.presetRow}>
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontSize: 14, fontWeight: 500 }}>{item.label || item.url.slice(0, 45)}</span>
                  <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                    {item.modName} · {formatTime(item.playedAt)} · {item.type}
                  </div>
                </div>
                <button style={s.smBtn} onClick={() => { setUrl(item.url); setLabel(item.label || ''); setVolume(item.volume || 80); setLoop(item.loop || false); setFit(item.fit || 'contain'); setTab('send') }}>
                  Reuse
                </button>
              </div>
            ))}
          </div>
        )}

        <button style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: 12, cursor: 'pointer', marginTop: 8 }}
          onClick={() => setAuthed(false)}>Sign out</button>
      </div>
    </div>
  )
}

const s = {
  loginWrap: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a', fontFamily: 'system-ui, sans-serif' },
  loginBox: { background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: '2rem 2.5rem', width: 340, textAlign: 'center', color: '#f1f5f9' },
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
  btn: { border: 'none', borderRadius: 6, padding: '9px 18px', color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer' },
  tabBtn: { border: '1px solid', borderRadius: 6, padding: '7px 16px', fontSize: 13, fontWeight: 500, cursor: 'pointer' },
  smBtn: { background: 'none', border: '1px solid #334155', borderRadius: 6, padding: '4px 10px', color: '#cbd5e1', fontSize: 12, cursor: 'pointer' },
  clearBtn: { background: 'none', border: '1px solid #fca5a5', borderRadius: 6, padding: '4px 12px', color: '#ef4444', fontSize: 13, cursor: 'pointer', flexShrink: 0 },
  err: { fontSize: 13, color: '#ef4444', marginBottom: 4 },
  liveBar: { background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 14px', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  presetRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #1e293b' },
  toast: { position: 'fixed', top: 16, right: 16, background: '#1e293b', border: '1px solid #3b82f6', borderRadius: 8, padding: '10px 16px', fontSize: 14, color: '#60a5fa', zIndex: 999 },
}

export default function App() {
  const [mode, setMode] = useState(null)
  useEffect(() => setMode(window.location.hash === '#overlay' ? 'overlay' : 'control'), [])
  if (!mode) return null
  return mode === 'overlay' ? <Overlay /> : <ControlPanel />
}
