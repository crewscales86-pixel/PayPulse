const { useState, useEffect, useCallback } = React;
const API = 'http://localhost:3000';

// ─── ICONS ───────────────────────────────────────────────────────
const Icons = {
  zap: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>,
  check: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5"/></svg>,
  alert: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 22h20L12 2zm0 3.5L18.5 19H5.5L12 5.5zM11 10v6h2v-6h-2zm0 8v2h2v-2h-2z"/></svg>,
  pause: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>,
  bell: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
  card: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V10h16v8zm0-10H4V6h16v2z"/></svg>,
  copy: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>,
};

// ─── CUSTOMER CARD ─────────────────────────────────────────────
function CustomerCard({ customer, onCharge, onEdit, onAnalytics }) {
  return (
    <div className="cust-card">
      <div className="cust-name">{customer.name}</div>
      <div className="cust-email">{customer.email}</div>
      <div className="cust-meta">
        {customer.cardOnFile
          ? <span className="tag tag-green"><Icons.card/> Card on file</span>
          : <span className="tag tag-red">No card</span>
        }
        <span className="rate">${customer.ratePerTrigger}/trigger</span>
      </div>
      <div className="cust-actions">
        <button className="btn-sm green" onClick={() => onCharge(customer)}>Charge</button>
        <button className="btn-sm" onClick={() => onEdit(customer)}>Edit</button>
        <button className="btn-sm purple" onClick={() => onAnalytics(customer)}>Analytics</button>
      </div>
    </div>
  );
}

// ─── CUSTOMERS PAGE ─────────────────────────────────────────────
function CustomersPage({ customers, onRefresh }) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [chargeModal, setChargeModal] = useState(null);
  const [editModal, setEditModal] = useState(null);
  const [note, setNote] = useState('');

  const processors = { all: 'All', whop: 'Whop', stripe: 'Stripe', fanbasis: 'Fanbasis' };

  const filtered = customers.filter(c => {
    if (filter !== 'all' && filter !== c.processor) return false;
    if (search && !c.name.toLowerCase().includes(search.toLowerCase()) && !c.email.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const byStatus = { new: [], active: [], at_risk: [], paused: [] };
  filtered.forEach(c => {
    const s = byStatus[c.status] ? c.status : 'new';
    byStatus[s].push(c);
  });

  const doCharge = async () => {
    await fetch(`${API}/api/customers/${chargeModal.id}/charge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note })
    });
    setChargeModal(null); setNote(''); onRefresh();
  };

  const doEdit = async () => {
    await fetch(`${API}/api/customers/${editModal.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ratePerTrigger: editModal.ratePerTrigger, status: editModal.status, name: editModal.name })
    });
    setEditModal(null); onRefresh();
  };

  const colConfig = [
    { key: 'new', label: 'New', icon: <Icons.card/>, color: '#4488ff' },
    { key: 'active', label: 'Active', icon: <Icons.check/>, color: '#00ff88' },
    { key: 'at_risk', label: 'At Risk', icon: <Icons.alert/>, color: '#ff4444' },
    { key: 'paused', label: 'Paused', icon: <Icons.pause/>, color: '#ffaa00' },
  ];

  return (
    <div className="page">
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-label">Customers</div>
          <div className="stat-value">{customers.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Cards on File</div>
          <div className="stat-value blue">{customers.filter(c => c.cardOnFile).length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total Charged</div>
          <div className="stat-value">${customers.reduce((s, c) => s + c.totalCharged, 0).toFixed(0)}</div>
        </div>
      </div>

      <div className="filters">
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ fontWeight:700, fontSize:13, textTransform:'uppercase', letterSpacing:1 }}>Customers</span>
          <span className="tag tag-green" style={{ borderRadius:10 }}>{customers.length}</span>
        </div>
        <div className="nav-spacer"></div>
        <button className="btn-sm green" style={{ padding:'8px 16px' }} onClick={onRefresh}>⟳ Sync Customers</button>
        <input className="search-box" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="filters" style={{ marginBottom:24 }}>
        {Object.entries(processors).map(([k, v]) => (
          <div key={k} className={`filter-pill ${filter===k ? 'active' : ''}`} onClick={() => setFilter(k)}>
            {k === 'whop' && <Icons.zap/>} {k === 'stripe' && <span style={{color:'#4488ff'}}>◆</span>} {v}
            <span className="count">{k === 'all' ? customers.length : customers.filter(c => c.processor === k).length}</span>
          </div>
        ))}
      </div>

      <div className="kanban">
        {colConfig.map(col => (
          <div key={col.key} className="kanban-col">
            <div className="kanban-col-header">
              <span className="dot" style={{ background: col.color }}></span>
              {col.icon} {col.label}
              <span className="count">{byStatus[col.key].length}</span>
            </div>
            {byStatus[col.key].map(c => (
              <CustomerCard
                key={c.id}
                customer={c}
                onCharge={setChargeModal}
                onEdit={setEditModal}
                onAnalytics={() => alert('Analytics: ' + c.name + ' \u2014 ' + c.totalTriggers + ' triggers, $' + c.totalCharged.toFixed(2) + ' charged')}
              />
            ))}
            {byStatus[col.key].length === 0 && (
              <div style={{ color: '#555', fontSize: 13, textAlign: 'center', padding: 40 }}>No clients</div>
            )}
          </div>
        ))}
      </div>

      {chargeModal && (
        <div className="modal-back" onClick={e => e.target === e.currentTarget && setChargeModal(null)}>
          <div className="modal">
            <h3>Charge {chargeModal.name}</h3>
            <div className="form-group">
              <label>Amount</label>
              <input value={`$${chargeModal.ratePerTrigger}`} disabled />
            </div>
            <div className="form-group">
              <label>Note (optional)</label>
              <input placeholder="e.g. Monthly retainer" value={note} onChange={e => setNote(e.target.value)} />
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setChargeModal(null)}>Cancel</button>
              <button className="btn-primary" onClick={doCharge}>Charge ${chargeModal.ratePerTrigger}</button>
            </div>
          </div>
        </div>
      )}

      {editModal && (
        <div className="modal-back" onClick={e => e.target === e.currentTarget && setEditModal(null)}>
          <div className="modal">
            <h3>Edit {editModal.name}</h3>
            <div className="form-group">
              <label>Name</label>
              <input value={editModal.name} onChange={e => setEditModal({...editModal, name: e.target.value})} />
            </div>
            <div className="form-group">
              <label>Rate per Trigger ($)</label>
              <input type="number" value={editModal.ratePerTrigger} onChange={e => setEditModal({...editModal, ratePerTrigger: parseFloat(e.target.value)||0})} />
            </div>
            <div className="form-group">
              <label>Status</label>
              <select value={editModal.status} onChange={e => setEditModal({...editModal, status: e.target.value})}>
                <option value="new">New</option>
                <option value="active">Active</option>
                <option value="at_risk">At Risk</option>
                <option value="paused">Paused</option>
              </select>
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setEditModal(null)}>Cancel</button>
              <button className="btn-primary" onClick={doEdit}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SETTINGS PAGE ───────────────────────────────────────────────
function SettingsPage({ settings, onSave }) {
  const [s, setS] = useState(settings || {});
  const [saved, setSaved] = useState(false);
  const [templateInput, setTemplateInput] = useState('');

  useEffect(() => { if (settings) setS(settings); }, [settings]);

  const save = async () => {
    await fetch(`${API}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
    setSaved(true); setTimeout(() => setSaved(false), 2000); onSave();
  };

  const addTemplate = async () => {
    if (!templateInput.trim()) return;
    await fetch(`${API}/api/settings/note-templates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ add: templateInput }) });
    setTemplateInput(''); onSave();
  };

  const copy = (text) => { navigator.clipboard.writeText(text); };

  return (
    <div className="page">
      <div className="settings-grid">
        <div className="settings-card">
          <h3>Payment Processor</h3>
          <div className="form-group">
            <label>Your Name</label>
            <input value={s.companyName || ''} onChange={e => setS({...s, companyName: e.target.value})} />
          </div>
          <div className="form-group">
            <label>Select Processor</label>
            <div className="processor-tabs">
              {['whop','stripe','fanbasis'].map(p => (
                <div key={p} className={`proc-tab ${s.processor===p ? 'active' : ''}`} onClick={() => setS({...s, processor: p})}>
                  {p === 'whop' && <Icons.zap/>} {p === 'stripe' && <span style={{color:'#4488ff'}}>◆</span>} {p === 'fanbasis' && <span style={{color:'#ffaa00'}}>★</span>}
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </div>
              ))}
            </div>
          </div>
          {s.processor === 'whop' && (
            <>
              <div className="form-group">
                <label>Whop API Key</label>
                <input type="password" value={s.whopApiKey || ''} onChange={e => setS({...s, whopApiKey: e.target.value})} placeholder="whop_..." />
              </div>
              <div className="form-group">
                <label>Whop Company ID</label>
                <input value={s.whopCompanyId || ''} onChange={e => setS({...s, whopCompanyId: e.target.value})} placeholder="biz_..." />
              </div>
            </>
          )}
          {s.processor === 'stripe' && (
            <>
              <div className="form-group">
                <label>Stripe Secret Key</label>
                <input type="password" value={s.stripeSecretKey || ''} onChange={e => setS({...s, stripeSecretKey: e.target.value})} placeholder="sk_live_..." />
              </div>
              <div className="form-group">
                <label>Stripe Publishable Key</label>
                <input value={s.stripePublishableKey || ''} onChange={e => setS({...s, stripePublishableKey: e.target.value})} placeholder="pk_live_..." />
              </div>
            </>
          )}
          <button className="btn-primary" onClick={save}>{saved ? 'Saved!' : 'Save Changes'}</button>
        </div>

        <div className="settings-card">
          <h3>Appointment Tracking Mode</h3>
          <div className="toggle-row" style={{ marginBottom: 14 }}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Appointment Tracking Mode</div>
              <div style={{ color: 'var(--text2)', fontSize: 13, lineHeight: 1.5 }}>
                When ON — GHL triggers create a pending appointment instead of charging immediately. You mark each appointment as Showed, No-Show, or Cancelled. Only Showed appointments charge the card.
              </div>
            </div>
            <div className={`toggle ${s.appointmentTrackingMode ? 'on' : ''}`} onClick={() => setS({...s, appointmentTrackingMode: !s.appointmentTrackingMode})}></div>
          </div>
        </div>

        <div className="settings-card">
          <h3>Charge Note Templates</h3>
          <div style={{ display:'flex', gap:10, marginBottom:16 }}>
            <input placeholder="e.g. Monthly retainer" value={templateInput} onChange={e => setTemplateInput(e.target.value)} />
            <button className="btn-primary" onClick={addTemplate}>Add</button>
          </div>
          {(s.chargeNoteTemplates || []).length === 0 && <div style={{ color:'#555', fontSize:13 }}>No templates yet</div>}
          {(s.chargeNoteTemplates || []).map((t, i) => (
            <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'8px 12px', background:'var(--surface2)', borderRadius:6, marginBottom:6, fontSize:13 }}>
              {t}
              <span style={{ color:'#ff4444', cursor:'pointer', fontSize:11 }} onClick={async () => { await fetch(`${API}/api/settings/note-templates`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({remove:t})}); onSave(); }}>Remove</span>
            </div>
          ))}
        </div>

        <div className="settings-card">
          <h3>Webhook URLs</h3>
          <div className="form-group">
            <label>Whop Webhook URL — Paste into Whop → Settings → Webhooks</label>
            <div className="webhook-box">{s.whopWebhookUrl || 'Loading...'}</div>
            <button className="copy-btn" onClick={() => copy(s.whopWebhookUrl)}><Icons.copy/> Copy</button>
            <div style={{ color:'var(--text2)', fontSize:12, marginTop:8 }}>Events: <span style={{ color:'var(--text)' }}>payment.succeeded  membership.went_valid</span></div>
          </div>
          <div className="form-group">
            <label>GHL Trigger URL — Paste into GoHighLevel Webhook Action</label>
            <div className="webhook-box blue">{s.ghlTriggerUrl || 'Loading...'}</div>
            <button className="copy-btn" onClick={() => copy(s.ghlTriggerUrl)}><Icons.copy/> Copy</button>
            <div style={{ color:'var(--text2)', fontSize:12, marginTop:8 }}>Send body: <span style={{ color:'var(--blue)' }}>whop_member_id</span> + <span style={{ color:'var(--blue)' }}>whop_payment_method_id</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── INBOX PAGE ───────────────────────────────────────────────────
function InboxPage({ notifications, onRefresh }) {
  const markAll = async () => { await fetch(`${API}/api/notifications/read`, {method:'POST'}); onRefresh(); };

  const iconFor = (type) => {
    if (type === 'success') return <div className="notif-icon success"><Icons.check/></div>;
    if (type === 'fail') return <div className="notif-icon fail"><Icons.alert/></div>;
    if (type === 'trigger') return <div className="notif-icon trigger"><Icons.zap/></div>;
    return <div className="notif-icon new" style={{color:'#4488ff'}}><Icons.card/></div>;
  };

  const fmt = (iso) => {
    const d = new Date(iso);
    return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}, ${d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}`;
  };

  return (
    <div className="page">
      <div className="notif-list">
        <div className="notif-header">
          <h3><span style={{ color:'var(--accent)' }}>Notifications</span> Inbox</h3>
          <span className="mark-read" onClick={markAll}>Mark all read</span>
        </div>
        {notifications.map(n => (
          <div key={n.id} className={`notif-item ${!n.read ? 'unread' : ''}`}>
            {iconFor(n.type)}
            <div style={{ flex:1 }}>
              <div className="notif-title">{n.title}</div>
              <div className="notif-body">{n.body}</div>
              <div className="notif-time">{fmt(n.timestamp)}</div>
            </div>
            <button className="notif-view">View</button>
          </div>
        ))}
        {notifications.length === 0 && (
          <div style={{ padding: 40, textAlign:'center', color:'#555' }}>No notifications yet</div>
        )}
      </div>
    </div>
  );
}

// ─── CHARGES PAGE ────────────────────────────────────────────────
function ChargesPage({ charges }) {
  const fmt = (iso) => {
    const d = new Date(iso);
    return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}, ${d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}`;
  };

  return (
    <div className="page">
      <div className="page-title">Charge History</div>
      <div className="table-wrap">
        <table>
          <thead><tr>
            <th>Status</th><th>Customer</th><th>Amount</th><th>Processor</th><th>Note</th><th>Time</th>
          </tr></thead>
          <tbody>
            {charges.map(c => (
              <tr key={c.id}>
                <td>
                  <span className={`status-dot ${c.status==='succeeded'?'ok':c.status==='failed'?'fail':'warn'}`}></span>
                  <span style={{ textTransform:'capitalize' }}>{c.status}</span>
                </td>
                <td><strong>{c.customerName}</strong><br/><span style={{color:'var(--text2)',fontSize:12}}>{c.customerEmail}</span></td>
                <td><strong>${c.amount.toFixed(2)}</strong></td>
                <td style={{ textTransform:'capitalize' }}>{c.processor}</td>
                <td style={{ color:'var(--text2)' }}>{c.note || '-'}</td>
                <td style={{ color:'var(--text2)', fontSize:12 }}>{fmt(c.timestamp)}</td>
              </tr>
            ))}
            {charges.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign:'center', color:'#555', padding:40 }}>No charges yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── APP ────────────────────────────────────────────────────────────
function App() {
  const [page, setPage] = useState('customers');
  const [customers, setCustomers] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [settings, setSettings] = useState(null);
  const [charges, setCharges] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [cRes, nRes, sRes, chRes, uRes] = await Promise.all([
        fetch(`${API}/api/customers`),
        fetch(`${API}/api/notifications`),
        fetch(`${API}/api/settings`),
        fetch(`${API}/api/charges`),
        fetch(`${API}/api/notifications/unread-count`),
      ]);
      setCustomers(await cRes.json());
      setNotifications(await nRes.json());
      setSettings(await sRes.json());
      setCharges(await chRes.json());
      setUnreadCount((await uRes.json()).count);
    } catch (e) { console.error('Refresh failed', e); }
  }, []);

  useEffect(() => { refresh(); const iv = setInterval(refresh, 5000); return () => clearInterval(iv); }, [refresh]);

  const navItems = [
    { key: 'customers', label: 'Customers', icon: <Icons.card/> },
    { key: 'settings', label: 'Settings', icon: '⚙️' },
    { key: 'charges', label: 'Charges', icon: <Icons.zap/> },
  ];

  return (
    <div>
      <nav className="nav">
        <div className="logo">
          <div className="logo-icon">⚡</div>
          <span style={{ color: 'var(--accent)' }}>PAYPULSE</span>
        </div>
        {navItems.map(item => (
          <div key={item.key} className={`nav-link ${page===item.key ? 'active' : ''}`} onClick={() => setPage(item.key)}>
            {item.icon} {item.label}
          </div>
        ))}
        <div className="nav-spacer"></div>
        <button className="inbox-btn" onClick={() => setPage('inbox')}>
          <Icons.bell/>
          {unreadCount > 0 && <span className="badge">{unreadCount}</span>}
        </button>
        <div className="nav-link" style={{ opacity: 0.6, cursor: 'default' }}>⭐</div>
        <div className="nav-link" style={{ fontSize:12 }}>{settings?.companyName || 'Conversion Empire'}</div>
        <div className="nav-link" style={{ opacity: 0.5 }}>Sign Out</div>
      </nav>

      {page === 'customers' && <CustomersPage customers={customers} onRefresh={refresh} />}
      {page === 'settings' && <SettingsPage settings={settings} onSave={refresh} />}
      {page === 'inbox' && <InboxPage notifications={notifications} onRefresh={refresh} />}
      {page === 'charges' && <ChargesPage charges={charges} />}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App/>);
