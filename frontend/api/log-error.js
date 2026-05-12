// Receives browser-side errors from error-logger.js and persists them to
// data/logs/browser-errors.json in the repo (keeping the most recent N).
//
// Storage strategy:
//   - Single JSON file overwritten in place — last MAX_KEEP errors only.
//   - File lives outside data/uploads/_inbox/** so the ingest workflow
//     doesn't re-trigger when errors are logged.
//   - One commit per POST. For a solo dashboard this is fine; if error
//     volume ever spikes, the client-side dedup + batching caps the rate
//     and the rolling cap prevents the file growing forever.
//
// Required env vars (already configured for the upload endpoint):
//   GH_TOKEN   — fine-grained PAT, Contents R/W on this repo
//   GH_REPO    — 'tmlangmaid-gif/Nota_GP_race_Dash'

const FILE_PATH = 'data/logs/browser-errors.json';
const MAX_KEEP  = 200;

function clean(e, defaultUA) {
  const limit = (v, n) => (v == null ? null : String(v).slice(0, n));
  return {
    ts:        new Date().toISOString(),
    type:      limit(e && e.type, 80),
    message:   limit(e && e.message, 1500),
    source:    limit(e && e.source, 500),
    line:      Number.isFinite(+(e && e.line)) ? +e.line : null,
    col:       Number.isFinite(+(e && e.col))  ? +e.col  : null,
    stack:     limit(e && e.stack, 5000),
    url:       limit(e && e.url, 500),
    userAgent: limit(defaultUA, 300),
    extra:     (e && e.extra && typeof e.extra === 'object')
                 ? JSON.stringify(e.extra).slice(0, 2000)
                 : null
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // TEMP DIAGNOSTIC: ?debug=1 returns JSON with env presence + GitHub
  // probe status (no secret values) so we can verify a Vercel deployment
  // has functional env vars. Remove this block once setup is verified.
  const debug = req.url && req.url.indexOf('debug=1') >= 0;

  // Vercel auto-parses application/json; sendBeacon may deliver as Blob
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  let errors = [];
  if (Array.isArray(body.errors)) errors = body.errors;
  else if (body.message || body.type) errors = [body];
  if (!errors.length) return res.status(204).end();

  const userAgent = (req.headers && req.headers['user-agent']) || '';
  const cleaned = errors.slice(0, MAX_KEEP).map(e => clean(e, userAgent));

  const repo  = process.env.GH_REPO;
  const token = process.env.GH_TOKEN;
  if (!repo || !token) {
    console.error('log-error: GH_TOKEN/GH_REPO missing; dropping batch', cleaned);
    if (debug) return res.status(200).json({
      env: { GH_REPO_present: !!repo, GH_TOKEN_present: !!token,
             GH_TOKEN_length: (token || '').length },
      result: 'env-missing'
    });
    return res.status(204).end();
  }

  const apiBase = 'https://api.github.com/repos/' + repo + '/contents/'
    + FILE_PATH.split('/').map(encodeURIComponent).join('/');
  const ghHeaders = {
    'Authorization':        'Bearer ' + token,
    'Accept':               'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent':           'doonan-error-logger'
  };

  // GET existing
  let existingSha = null;
  let existingErrors = [];
  let probeStatus = null;
  let probeBody = null;
  try {
    const probe = await fetch(apiBase + '?ref=main', { headers: ghHeaders });
    probeStatus = probe.status;
    if (probe.status === 200) {
      const j = await probe.json();
      existingSha = j.sha;
      const raw = Buffer.from(j.content || '', 'base64').toString('utf-8');
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) existingErrors = parsed;
      } catch { /* will overwrite */ }
    } else if (probe.status !== 404) {
      probeBody = (await probe.text()).slice(0, 500);
      console.error('log-error: probe non-OK', probe.status, probeBody);
    }
  } catch (e) {
    probeStatus = 'fetch-error';
    probeBody = String(e).slice(0, 500);
    console.error('log-error: probe error', probeBody);
  }

  // Newest first; cap to MAX_KEEP
  const combined = [...cleaned, ...existingErrors].slice(0, MAX_KEEP);
  const newContent = JSON.stringify(combined, null, 2) + '\n';
  const contentBase64 = Buffer.from(newContent, 'utf-8').toString('base64');

  const firstMsg = (cleaned[0].message || cleaned[0].type || 'browser error').slice(0, 60);
  const putBody = {
    message: 'log: browser error — ' + firstMsg,
    content: contentBase64,
    branch:  'main'
  };
  if (existingSha) putBody.sha = existingSha;

  let putStatus = null;
  let putBody = null;
  try {
    const putRes = await fetch(apiBase, {
      method:  'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body:    JSON.stringify(putBody)
    });
    putStatus = putRes.status;
    if (!putRes.ok) {
      putBody = (await putRes.text()).slice(0, 500);
      console.error('log-error: PUT failed', putRes.status, putBody);
    }
  } catch (e) {
    putStatus = 'fetch-error';
    putBody = String(e).slice(0, 500);
    console.error('log-error: PUT error', putBody);
  }

  if (debug) return res.status(200).json({
    env: {
      GH_REPO: repo,
      GH_TOKEN_present: true,
      GH_TOKEN_length: token.length,
      GH_TOKEN_prefix: token.slice(0, 11)
    },
    probe_status: probeStatus,
    probe_body: probeBody,
    put_status: putStatus,
    put_body: putBody
  });

  // Always 204 — never let the client retry. Worst case we lose the batch.
  return res.status(204).end();
}
