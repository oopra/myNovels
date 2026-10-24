import React, { useEffect, useState } from 'react';
import type { PassName, ProviderId, ModelInfo } from '../../shared/types';
import { PASS_LABELS, PASS_DEFAULT_PROVIDER } from '../../shared/types';
import { api } from '../api';
import { useApp } from '../App';

const PASSES = Object.keys(PASS_LABELS) as PassName[];

export function Settings() {
  const { toast, refreshNovel } = useApp();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [keys, setKeys] = useState<{ mode: string; anthropic: boolean; gemini: boolean } | null>(null);
  const [status, setStatus] = useState<{ id: ProviderId; mode: string; ready: boolean; reason?: string; model: string; hasKey: boolean }[]>([]);
  const [models, setModels] = useState<Record<ProviderId, ModelInfo[]>>({ anthropic: [], gemini: [] });
  const [keyInput, setKeyInput] = useState<Record<ProviderId, string>>({ anthropic: '', gemini: '' });
  const [testing, setTesting] = useState<Record<string, string>>({});
  const [usage, setUsage] = useState<{ provider: string; month: string; input_tokens: number; output_tokens: number; runs: number }[]>([]);
  const [promptPass, setPromptPass] = useState<PassName>('critique');
  const [promptText, setPromptText] = useState('');
  const [promptVersion, setPromptVersion] = useState('');
  const load = async () => {
    const [s, k, st, u] = await Promise.all([api.settings(), api.keys(), api.providers(), api.usage()]);
    setSettings(s); setKeys(k); setStatus(st); setUsage(u);
    for (const p of st) if (p.ready) api.models(p.id).then(m => setModels(x => ({ ...x, [p.id]: m }))).catch(() => {});
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { api.prompt(promptPass).then(p => { setPromptText(p.text); setPromptVersion(p.version); }); }, [promptPass]);
  const set = async (k: string, v: string) => { try { setSettings(await api.saveSettings({ [k]: v })); if (k === 'title') refreshNovel(); if (k.startsWith('anthropic.mode')) load(); } catch (e) { toast((e as Error).message, 'err'); } };
  const saveKey = async (p: ProviderId) => { try { await api.setKey(p, keyInput[p]); setKeyInput(x => ({ ...x, [p]: '' })); toast(keyInput[p] ? 'Key saved' : 'Key removed'); load(); } catch (e) { toast((e as Error).message, 'err'); } };
  const test = async (p: ProviderId) => {
    setTesting(t => ({ ...t, [p]: 'Testing…' }));
    const r = await api.testConnection(p);
    setTesting(t => ({ ...t, [p]: r.ok ? `OK · ${r.mode} · ${r.models} models · token count ${r.tokenCount ?? 'n/a'}` : `Failed: ${r.error}` }));
    if (r.ok) api.models(p).then(m => setModels(x => ({ ...x, [p]: m })));
  };
  const savePrompt = async () => { const p = await api.savePrompt(promptPass, promptText); setPromptVersion(p.version); toast(`Prompt saved (version ${p.version})`); };
  const modelSelect = (p: ProviderId, key: string, allowDefault: boolean) => (
    <select value={settings[key] ?? ''} onChange={e => set(key, e.target.value)}>
      {allowDefault && <option value="">provider default</option>}
      {!allowDefault && !settings[key] && <option value="">{p === 'anthropic' ? 'claude-sonnet-5-5 (default)' : 'pick a model (fetch list first)'}</option>}
      {models[p].map(m => <option key={m.id} value={m.id}>{m.name} · {m.id}</option>)}
      {settings[key] && !models[p].some(m => m.id === settings[key]) && <option value={settings[key]}>{settings[key]}</option>}
    </select>
  );
  return (
    <div className="pad">
      <h1>Settings</h1>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Novel</h2>
        <div className="settings-grid">
          <label>Title</label><input defaultValue={settings.title ?? ''} onBlur={e => e.target.value !== (settings.title ?? '') && set('title', e.target.value)} />
          <label>Export path</label><input className="mono" defaultValue={settings['export.path'] ?? ''} placeholder="<novel folder>/manuscript" onBlur={e => e.target.value !== (settings['export.path'] ?? '') && set('export.path', e.target.value)} />
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Providers</h2>
        <p className="muted small">Keys are stored in {keys?.mode === 'keychain' ? 'the OS keychain' : 'a 0600 file in the app config directory (the OS keychain library could not load on this machine)'}, never in the novel folder or its database.</p>
        {status.map(s => (
          <div key={s.id} style={{ marginBottom: 16 }}>
            <div className="row"><strong>{s.id === 'anthropic' ? 'Claude (Anthropic)' : 'Gemini (Google)'}</strong><span className={`badge ${s.ready ? 'ok' : 'err'}`}>{s.ready ? 'ready' : 'not ready'}</span><span className="muted small">{s.mode}</span></div>
            {!s.ready && s.reason && <div className="muted small">{s.reason}</div>}
            <div className="settings-grid" style={{ marginTop: 8 }}>
              {s.id === 'anthropic' && (<>
                <label>Mode</label>
                <select value={settings['anthropic.mode'] ?? ''} onChange={e => set('anthropic.mode', e.target.value)}>
                  <option value="">auto (Max login via claude CLI when available, else API key)</option>
                  <option value="cli">Max login via claude CLI</option>
                  <option value="api">API key</option>
                </select>
              </>)}
              <label>{s.id === 'anthropic' ? 'API key (fallback)' : 'API key (AI Studio)'}</label>
              <div className="row">
                <input type="password" placeholder={s.hasKey ? '•••••••• saved — paste to replace, save empty to remove' : 'paste key'} value={keyInput[s.id]} onChange={e => setKeyInput(x => ({ ...x, [s.id]: e.target.value }))} style={{ flex: 1 }} />
                <button onClick={() => saveKey(s.id)}>Save</button>
              </div>
              <label>Default model</label>
              <div className="row">{modelSelect(s.id, `${s.id}.model`, false)}<button className="small" onClick={() => api.models(s.id, true).then(m => setModels(x => ({ ...x, [s.id]: m }))).catch(e => toast(e.message, 'err'))}>Fetch list</button></div>
              <label>Connection</label>
              <div className="row"><button onClick={() => test(s.id)}>Test connection</button><span className="small">{testing[s.id]}</span></div>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Routing per pass</h2>
        <table>
          <thead><tr><th>Pass</th><th>Provider</th><th>Model</th></tr></thead>
          <tbody>
            {PASSES.map(p => {
              const prov = (settings[`pass.${p}.provider`] as ProviderId) || PASS_DEFAULT_PROVIDER[p];
              return (
                <tr key={p}>
                  <td>{PASS_LABELS[p]}</td>
                  <td>{p === 'stress' ? <span className="muted">both, always</span> : (
                    <select value={settings[`pass.${p}.provider`] ?? ''} onChange={e => set(`pass.${p}.provider`, e.target.value)}>
                      <option value="">default ({PASS_DEFAULT_PROVIDER[p]})</option><option value="anthropic">anthropic</option><option value="gemini">gemini</option>
                    </select>)}</td>
                  <td>{p === 'stress' ? <div className="row">{modelSelect('anthropic', `pass.${p}.model.anthropic`, true)}{modelSelect('gemini', `pass.${p}.model.gemini`, true)}</div> : modelSelect(prov, `pass.${p}.model.${prov}`, true)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted small">Heavier critique: set Critique's model to claude-opus-5-5. Research always turns on search grounding; nothing else does.</p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Prompts</h2>
        <p className="muted small">Stored as markdown in the novel's <span className="mono">prompts/</span> folder. Each review records the prompt version it ran. The critique-first parser still applies whatever you write here.</p>
        <div className="row"><select value={promptPass} onChange={e => setPromptPass(e.target.value as PassName)}>{PASSES.map(p => <option key={p} value={p}>{PASS_LABELS[p]}</option>)}</select><span className="muted small">version {promptVersion}</span><button className="primary small" onClick={savePrompt}>Save prompt</button></div>
        <textarea value={promptText} onChange={e => setPromptText(e.target.value)} style={{ minHeight: 220, marginTop: 8 }} />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Usage</h2>
        {usage.length === 0 ? <div className="muted small">No runs yet.</div> : (
          <table><thead><tr><th>Month</th><th>Provider</th><th>Runs</th><th>Input tokens</th><th>Output tokens</th></tr></thead>
            <tbody>{usage.map((u, i) => <tr key={i}><td>{u.month}</td><td>{u.provider}</td><td>{u.runs}</td><td>{u.input_tokens.toLocaleString()}</td><td>{u.output_tokens.toLocaleString()}</td></tr>)}</tbody></table>
        )}
      </div>
    </div>
  );
}
