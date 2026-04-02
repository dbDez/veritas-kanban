/**
 * Claude Gateway
 *
 * Replaces the Clawdbot Gateway for Veritas Kanban Board Chat.
 * Implements the WebSocket protocol VK expects, routes messages to claude CLI.
 *
 * Usage:
 *   cd C:\Dev\veritas-kanban\gateway && node server.mjs
 *
 * Addressing agents:
 *   - Default           → Larry (CEO), single Haiku call, ~10-15s (CLI startup overhead)
 *   - @susan ...        → Susan subagent (Opus, ~20s)
 *   - @debugger ...     → Debugger subagent
 *   - @sql-pro ...      → SQL Pro subagent
 *   etc. — any name from AGENTS.md
 */

import { createServer }        from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID }          from 'crypto';
import { spawn }               from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir }              from 'os';
import { join }                from 'path';

const PORT       = 18789;
const VK_API     = 'http://localhost:3001';
const VK_KEY     = '9af8e50ed76959a2ab2603eaf3e8fdea64dffa16b62a33cf906add4091f1289d';
const CLAUDE_EXE = 'C:/Users/Pieters/.local/bin/claude.exe';  // forward slashes — avoid JS \b, \U etc. escape issues

// ── Agent definitions ─────────────────────────────────────────────────────────

const LARRY_SYSTEM_PROMPT = `You are Larry, the CEO of Pieter Sadie's development team.
You are direct, experienced, and carry full context of all his projects:
- Premier Voice AI — C# .NET 4.8 AI receptionist (Ozeki VoIP + Azure OpenAI Realtime API)
- ATS — Python trading system for XAGUSD/XAUUSD with 5-stage agent pipeline
- PAV Telecoms — SIM management, SCRAPO analytics, dealer maps, call centre tooling (MySQL/ScanDB)
- VBAConvert — Access-to-C# migration tool (200+ page spec)
- MT4 Expert Advisors — TVWebhookReceiver V8, AutoScale, AutoHedge, AutoGrow
- PAVCodingAgent — WinForms .NET AI chat client (current project)
You have a dry sense of humour. Be terse — say what needs saying and stop.
The Kanban board API is at ${VK_API}, admin key: ${VK_KEY}.
The user is Pieter Sadie, CIO at PAV Telecoms, Johannesburg, South Africa.`;

// Subagent types for @mention routing
const SUBAGENT_MAP = {
  susan:                         'susan',
  debugger:                      'debugger',
  'code-reviewer':               'code-reviewer',
  'azure-infra-engineer':        'azure-infra-engineer',
  'dotnet-48-expert':            'dotnet-framework-4.8-expert',
  'dotnet-framework-4.8-expert': 'dotnet-framework-4.8-expert',
  'fintech-engineer':            'fintech-engineer',
  'quant-analyst':               'quant-analyst',
  'security-auditor':            'security-auditor',
  'legacy-modernizer':           'legacy-modernizer',
  'sql-pro':                     'sql-pro',
  'powershell-51-expert':        'powershell-5.1-expert',
  'powershell-5.1-expert':       'powershell-5.1-expert',
  'websocket-engineer':          'websocket-engineer',
};

// ── Agent Registry ────────────────────────────────────────────────────────────

// All agents to register in Veritas Kanban Agent Registry
const AGENT_ROSTER = [
  { id: 'larry',                        name: 'Larry (CEO)',                 model: 'claude-opus-4-6',   capabilities: ['plan', 'code', 'research'] },
  { id: 'susan',                        name: 'Susan (HR Director)',         model: 'claude-opus-4-6',   capabilities: ['research'] },
  { id: 'debugger',                     name: 'Debugger',                    model: 'claude-sonnet-4-6', capabilities: ['debug'] },
  { id: 'code-reviewer',               name: 'Code Reviewer',               model: 'claude-opus-4-6',   capabilities: ['review', 'code'] },
  { id: 'azure-infra-engineer',        name: 'Azure Infra Engineer',        model: 'claude-sonnet-4-6', capabilities: ['devops'] },
  { id: 'dotnet-framework-4.8-expert', name: '.NET 4.8 Expert',             model: 'claude-sonnet-4-6', capabilities: ['code'] },
  { id: 'fintech-engineer',            name: 'Fintech Engineer',            model: 'claude-opus-4-6',   capabilities: ['code'] },
  { id: 'quant-analyst',              name: 'Quant Analyst',               model: 'claude-opus-4-6',   capabilities: ['data-analysis', 'research'] },
  { id: 'security-auditor',           name: 'Security Auditor',            model: 'claude-opus-4-6',   capabilities: ['security', 'review'] },
  { id: 'legacy-modernizer',          name: 'Legacy Modernizer',           model: 'claude-sonnet-4-6', capabilities: ['code', 'refactor'] },
  { id: 'sql-pro',                    name: 'SQL Pro',                     model: 'claude-sonnet-4-6', capabilities: ['data-analysis', 'code'] },
  { id: 'powershell-5.1-expert',      name: 'PowerShell 5.1 Expert',       model: 'claude-sonnet-4-6', capabilities: ['devops', 'code'] },
  { id: 'websocket-engineer',         name: 'WebSocket Engineer',          model: 'claude-sonnet-4-6', capabilities: ['code'] },
];

// Maps Claude subagent type → registry agent ID (for busy/idle heartbeats)
const SUBAGENT_TO_REGISTRY_ID = {
  'susan':                         'susan',
  'debugger':                      'debugger',
  'code-reviewer':                 'code-reviewer',
  'azure-infra-engineer':          'azure-infra-engineer',
  'dotnet-framework-4.8-expert':   'dotnet-framework-4.8-expert',
  'fintech-engineer':              'fintech-engineer',
  'quant-analyst':                 'quant-analyst',
  'security-auditor':              'security-auditor',
  'legacy-modernizer':             'legacy-modernizer',
  'sql-pro':                       'sql-pro',
  'powershell-5.1-expert':         'powershell-5.1-expert',
  'websocket-engineer':            'websocket-engineer',
};

async function vkPost(path, body) {
  try {
    const res = await fetch(`${VK_API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': VK_KEY },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[registry] POST ${path} → ${res.status} ${text.substring(0, 80)}`);
    }
    return res.ok;
  } catch (err) {
    console.error(`[registry] POST ${path} failed:`, err.message);
    return false;
  }
}

async function registerAll() {
  console.log('[registry] Registering agents...');
  for (const agent of AGENT_ROSTER) {
    await vkPost('/api/agents/register', {
      id:           agent.id,
      name:         agent.name,
      model:        agent.model,
      provider:     'anthropic',
      capabilities: agent.capabilities.map(c => ({ name: c })),
      version:      '1.0',
      metadata:     { gateway: 'claude-gateway' },
    });
  }
  console.log('[registry] All agents registered.');
}

async function heartbeatAll() {
  for (const agent of AGENT_ROSTER) {
    const ok = await vkPost(`/api/agents/register/${encodeURIComponent(agent.id)}/heartbeat`, { status: 'idle' });
    if (!ok) {
      // Heartbeat 404 means VK server restarted and lost the registry — re-register
      await vkPost('/api/agents/register', {
        id:           agent.id,
        name:         agent.name,
        model:        agent.model,
        provider:     'anthropic',
        capabilities: agent.capabilities.map(c => ({ name: c })),
        version:      '1.0',
        metadata:     { gateway: 'claude-gateway' },
      });
    }
  }
}

async function setAgentStatus(registryId, status) {
  await vkPost(`/api/agents/register/${encodeURIComponent(registryId)}/heartbeat`, { status });
}

// ── Environment helpers ───────────────────────────────────────────────────────

/**
 * Strip VS Code / IDE integration env vars so spawned claude processes run as
 * pure CLI and don't connect to the VS Code extension's chat session.
 */
function cleanEnv() {
  const env = { ...process.env };
  const drop = [
    'VSCODE_IPC_HOOK_CLI', 'VSCODE_IPC_HOOK', 'VSCODE_CWD',
    'VSCODE_PID', 'VSCODE_NLS_CONFIG', 'VSCODE_HANDLES_UNCAUGHT_ERRORS',
    'VSCODE_AMD_ENTRYPOINT', 'VSCODE_CODE_CACHE_PATH',
    'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_IPC_SOCKET',
  ];
  for (const k of drop) delete env[k];
  // Also strip any remaining VSCODE_* vars
  for (const k of Object.keys(env)) {
    if (k.startsWith('VSCODE_') || k.startsWith('CLAUDE_CODE_')) delete env[k];
  }
  return env;
}

// ── Claude spawner ────────────────────────────────────────────────────────────

/**
 * Spawn claude with shell:false — bypasses cmd.exe so special characters
 * in the user's message (?  '  !  &  etc.) are never interpreted by the shell.
 *
 * Two modes:
 *   direct  — system-prompt-file + user message as positional arg (fast, Sonnet)
 *   subagent — single -p prompt that invokes the named subagent (Opus, ~20s)
 */
function spawnClaude({ systemPrompt, userMessage, subagent }) {
  let args = ['--dangerously-skip-permissions', '--print'];

  if (subagent) {
    // Subagent path: one -p arg containing routing instruction + message
    // Write to temp file to avoid any arg-length limits
    const prompt =
      `Invoke the ${subagent} subagent to respond to this Board Chat message from Pieter. ` +
      `Kanban API: ${VK_API}, admin key: ${VK_KEY}. ` +
      `Be concise — this is a chat interface. ` +
      `Message: ${userMessage}`;
    const tmpFile = join(tmpdir(), `vk-prompt-${randomUUID()}.txt`);
    writeFileSync(tmpFile, prompt, 'utf8');
    args.push('--model', 'sonnet');
    args.push('--system-prompt-file', tmpFile);
    // Empty user message — the routing instruction IS the prompt
    args.push('(see system prompt)');

    const proc = spawn(CLAUDE_EXE, args, { shell: false, windowsHide: true, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('close', () => { try { unlinkSync(tmpFile); } catch {} });
    return proc;
  }

  // Direct path: system prompt sets the persona; user message is the input
  const sysFile = join(tmpdir(), `vk-sys-${randomUUID()}.txt`);
  writeFileSync(sysFile, systemPrompt, 'utf8');
  args.push('--model', 'opus');
  args.push('--system-prompt-file', sysFile);
  args.push(userMessage);  // positional argument — no shell to mangle it

  const proc = spawn(CLAUDE_EXE, args, { shell: false, windowsHide: true, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  proc.on('close', () => { try { unlinkSync(sysFile); } catch {} });
  return proc;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── Server ────────────────────────────────────────────────────────────────────

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'Claude Gateway running', port: PORT }));
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  console.log(`[gateway] Connected: ${req.socket.remoteAddress}`);

  // Step 1: Challenge
  send(ws, { type: 'event', event: 'connect.challenge', payload: { challenge: randomUUID() } });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Step 2: Handshake
    if (msg.type === 'req' && msg.method === 'connect') {
      send(ws, { type: 'res', id: msg.id, ok: true, payload: { type: 'hello-ok', protocol: 3 } });
      return;
    }

    // Step 3: Chat message
    if (msg.type === 'req' && msg.method === 'chat.send') {
      const { message = '', sessionKey = '' } = msg.params || {};
      const runId = randomUUID();

      // Parse @mention
      const mentionMatch = message.match(/^@([\w.\-]+)\s*([\s\S]*)/);
      const atName       = mentionMatch ? mentionMatch[1].toLowerCase() : null;
      const subagent     = atName ? SUBAGENT_MAP[atName] : null;
      const userText     = mentionMatch ? (mentionMatch[2] || message) : message;

      // Determine which registry agent to mark busy/idle
      const registryId = subagent
        ? (SUBAGENT_TO_REGISTRY_ID[subagent] || null)
        : 'larry';

      console.log(subagent
        ? `[gateway] @${atName} (subagent, sonnet): "${userText.substring(0, 60)}"`
        : `[gateway] larry (direct, opus): "${message.substring(0, 60)}"`);

      send(ws, { type: 'res', id: msg.id, ok: true, payload: { runId } });

      // Mark agent as busy
      if (registryId) setAgentStatus(registryId, 'busy');

      const proc = spawnClaude({
        systemPrompt: LARRY_SYSTEM_PROMPT,
        userMessage:  userText,
        subagent:     subagent || null,
      });

      let accumulatedText = '';

      // Keepalive: send a delta every 5s so the client doesn't time out
      // while waiting for Claude CLI to finish (Windows buffers stdout until exit)
      const keepalive = setInterval(() => {
        send(ws, {
          type: 'event', event: 'chat',
          payload: {
            state: 'delta', sessionKey, runId,
            message: { content: [{ type: 'text', text: accumulatedText || '...' }] },
          },
        });
      }, 5000);

      proc.stdout.on('data', (chunk) => {
        accumulatedText += chunk.toString();
        send(ws, {
          type: 'event', event: 'chat',
          payload: {
            state: 'delta', sessionKey, runId,
            message: { content: [{ type: 'text', text: accumulatedText }] },
          },
        });
      });

      proc.stderr.on('data', (chunk) => process.stderr.write(chunk));

      proc.on('close', (code) => {
        clearInterval(keepalive);
        console.log(`[gateway] done — code=${code} chars=${accumulatedText.length}`);
        const finalText = accumulatedText.trim()
          || (code === 0 ? '(No text output.)' : `(claude exited code ${code})`);
        send(ws, {
          type: 'event', event: 'chat',
          payload: {
            state: 'final', sessionKey, runId,
            message: { content: [{ type: 'text', text: finalText }] },
            usage: {},
          },
        });
        // Mark agent as idle again
        if (registryId) setAgentStatus(registryId, 'idle');
      });

      proc.on('error', (err) => {
        clearInterval(keepalive);
        console.error('[gateway] spawn error:', err.message);
        send(ws, {
          type: 'event', event: 'chat',
          payload: { state: 'error', sessionKey, runId, errorMessage: err.message },
        });
        if (registryId) setAgentStatus(registryId, 'idle');
      });
    }
  });

  ws.on('close', () => console.log('[gateway] Disconnected'));
  ws.on('error', (err) => console.error('[gateway] WS error:', err.message));
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`\n✓ Claude Gateway on ws://127.0.0.1:${PORT}`);
  console.log(`  Larry (direct, ~5s)  — type normally`);
  console.log(`  @agent-name (~20s)   — @susan, @debugger, @sql-pro, etc.\n`);

  // Register all agents, then start heartbeat interval (every 2 min)
  registerAll().then(() => {
    setInterval(heartbeatAll, 2 * 60 * 1000);
  });
});

// Deregister on clean shutdown (best-effort)
process.on('SIGINT',  () => { heartbeatAll().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { heartbeatAll().finally(() => process.exit(0)); });
