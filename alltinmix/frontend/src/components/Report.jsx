import React, { useState } from 'react';
import { api } from '../api';
import { useToast } from '../context';
import { Alert, Field } from './ui';
import { Modal } from '../pages/Orders';

const REASONS = [
  ['scam_fraud', 'Scam or fraud'],
  ['spam', 'Spam'],
  ['offensive', 'Offensive or abusive'],
  ['illegal', 'Illegal or prohibited item'],
  ['wrong_category', 'Wrong category or misleading'],
  ['other', 'Something else'],
];

/** Report a listing, a person or a message. Required by Apple and Google for apps with user-generated content. */
export function ReportModal({ targetType, targetId, onClose }) {
  const toast = useToast();
  const [reason, setReason] = useState('scam_fraud');
  const [details, setDetails] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api.post('/reports', { targetType, targetId, reason, details }); toast('Thanks. Our team will review your report.'); onClose(); }
    catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <Modal title="Report" onClose={onClose}>
      <form onSubmit={submit}>
        <Alert>{error}</Alert>
        <Field label="What is the problem?"><select value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></Field>
        <Field label="More details (optional)"><textarea value={details} onChange={(e) => setDetails(e.target.value)} maxLength={1000} /></Field>
        <div className="row"><button className="btn btn-danger" disabled={busy}>Send report</button><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button></div>
      </form>
    </Modal>
  );
}
