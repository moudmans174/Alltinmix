import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Ban, Flag } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../context';
import { ReportModal } from '../components/Report';
import { Alert, Empty, Spinner } from '../components/ui';

export function Inbox() {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/conversations').then((d) => setList(d.conversations)).catch((e) => setError(e.message)); }, []);
  return (
    <div className="container page" style={{ maxWidth: 760 }}>
      <h1>Messages</h1>
      <Alert>{error}</Alert>
      {!list ? <Spinner /> : list.length === 0 ? <Empty title="No conversations yet">Message a seller from any property, vehicle or other inquiry listing.</Empty> : (
        <div className="card" style={{ padding: 0 }}>
          {list.map((c) => (
            <Link key={c.id} to={`/messages/${c.id}`} className="convo">
              <div className="grow"><b>{c.otherName}</b> <span className="muted small">· {c.listingTitle}</span><div className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 480 }}>{c.lastMessage}</div></div>
              {c.unread > 0 && <span className="badge">{c.unread}</span>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function Thread() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);
  const toast = useToast();
  const nav = useNavigate();
  const end = useRef();

  const load = useCallback(() => api.get(`/conversations/${id}`).then(setData).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [data?.messages.length]);

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true); setError('');
    try { await api.post(`/conversations/${id}/messages`, { body: text }); setText(''); await load(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const block = async () => {
    if (!window.confirm(`Block ${data.conversation.otherName}? You will no longer see their listings or messages.`)) return;
    try { await api.post('/blocks', { userId: data.conversation.otherId }); toast('User blocked. You can undo this in Account.'); nav('/messages'); }
    catch (err) { toast(err.message, 'error'); }
  };

  if (error && !data) return <div className="container page"><Alert>{error}</Alert></div>;
  if (!data) return <Spinner />;
  return (
    <div className="container page" style={{ maxWidth: 760 }}>
      <p className="small"><Link to="/messages">← All messages</Link></p>
      <div className="row between"><h2 style={{ margin: 0 }}>{data.conversation.otherName}</h2>
        <div className="row"><button className="btn btn-ghost btn-sm" onClick={() => setReport({ type: 'user', id: data.conversation.otherId })}><Flag size={14} /> Report</button><button className="btn btn-ghost btn-sm" onClick={block}><Ban size={14} /> Block</button></div></div>
      <p className="muted">About <Link to={`/listing/${data.conversation.listingId}`}>{data.conversation.listingTitle}</Link></p>
      <div className="card">
        <div className="chat">
          {data.messages.map((m) => <div key={m.id} className={`bubble ${m.mine ? 'mine' : ''}`}>{m.body}{!m.mine && <button className="bubble-flag" aria-label="Report this message" title="Report this message" onClick={() => setReport({ type: 'message', id: m.id })}><Flag size={11} /></button>}</div>)}
          <div ref={end} />
        </div>
        <Alert>{error}</Alert>
        <form className="row" onSubmit={send} style={{ marginTop: 12, flexWrap: 'nowrap' }}>
          <input className="input grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a message…" maxLength={2000} aria-label="Message" />
          <button className="btn btn-primary" disabled={busy || !text.trim()}>Send</button>
        </form>
      </div>
      {report && <ReportModal targetType={report.type} targetId={report.id} onClose={() => setReport(null)} />}
    </div>
  );
}
