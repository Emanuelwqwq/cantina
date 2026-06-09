import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  deleteDoc,
  doc,
  query,
  where,
  orderBy,
  serverTimestamp,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import { firebaseConfig, schoolConfig } from './config.js';
import { AuthManager } from './auth.js';
import { Toast } from './toast.js';
import {
  validators,
  fmtDate,
  fmtTime,
  initials,
  today,
  PALETTE,
  getColor,
  delay,
  escapeHtml,
  exportToCSV,
  TURMAS
} from './utils.js';

// ══════════════════════════════════════════
// INICIALIZAÇÃO
// ══════════════════════════════════════════
let app, auth, db, authManager, toast;
let STUDENTS = [];
let LOGS = [];
let camStream = null;
let rafId = null;
let scanning = false;
let selectedStudent = null;
let _pendingUnsubscribe = null;
let _accessRequestsUnsubscribe = null; // listener de solicitações de acesso

// ── Modo aluno (sem Firebase Auth) ──
window.switchUserType = function(type) {
  document.getElementById('area-aluno').style.display = type === 'aluno' ? 'block' : 'none';
  document.getElementById('area-staff').style.display = type === 'staff' ? 'block' : 'none';
  document.getElementById('btn-type-aluno').classList.toggle('active', type === 'aluno');
  document.getElementById('btn-type-staff').classList.toggle('active', type === 'staff');
};

// ── Alternar sub-abas de aprovação ──
window.switchAprovTab = function(tab) {
  const isLogin = tab === 'logins';
  document.getElementById('section-logins').style.display = isLogin ? 'block' : 'none';
  document.getElementById('section-requests').style.display = isLogin ? 'none' : 'block';
  document.getElementById('tab-login-approvals').style.cssText = isLogin
    ? 'border-radius:8px 8px 0 0;border-bottom:2px solid #085041;color:#085041;font-weight:700;margin-bottom:-2px;'
    : 'border-radius:8px 8px 0 0;color:var(--gray-500);margin-bottom:-2px;';
  document.getElementById('tab-access-requests').style.cssText = !isLogin
    ? 'border-radius:8px 8px 0 0;border-bottom:2px solid #085041;color:#085041;font-weight:700;margin-bottom:-2px;'
    : 'border-radius:8px 8px 0 0;color:var(--gray-500);margin-bottom:-2px;';
};

document.addEventListener('DOMContentLoaded', async () => {
  toast = new Toast('toasts');

  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);

    authManager = new AuthManager(auth, db);
    authManager.onAuthChange(handleAuthChange);
    setupEventListeners();
    updateDateBadge();

  } catch (error) {
    document.getElementById('auth-screen').style.display = 'flex';
    document.getElementById('app-screen').style.display = 'none';
    document.getElementById('loading').classList.add('hidden');
    if (toast) toast.error('Erro ao conectar: ' + error.message);
  }
});

// ══════════════════════════════════════════
// AUTENTICAÇÃO
// ══════════════════════════════════════════
async function handleAuthChange(user) {
  const authScreen   = document.getElementById('auth-screen');
  const appScreen    = document.getElementById('app-screen');
  const pendingScreen = document.getElementById('pending-screen');
  const loading      = document.getElementById('loading');

  try {
    if (user) {
      pendingScreen.style.display = 'none';
      appScreen.style.display = 'block';
      await enterApp();
    } else {
      authScreen.style.display = 'flex';
      appScreen.style.display = 'none';
      if (pendingScreen) pendingScreen.style.display = 'none';
    }
  } catch (error) {
    console.error('Erro handleAuthChange:', error);
    if (toast) toast.error('Erro ao carregar a aplicação. Atualize a página.');
    authScreen.style.display = 'flex';
    appScreen.style.display = 'none';
    if (pendingScreen) pendingScreen.style.display = 'none';
  } finally {
    if (loading) loading.classList.add('hidden');
  }
}

async function enterApp() {
  const displayName = authManager.userName || authManager.currentUser?.displayName || authManager.currentUser?.email?.split('@')[0] || '';
  document.getElementById('user-name').textContent = displayName;
  document.getElementById('fb-dot').classList.add('online');
  document.getElementById('fb-status').textContent = 'Conectado';

  await loadAll();
  applyPermissions();  // FIX: role já foi carregado antes de chegar aqui

  // Se for admin, começa a ouvir solicitações pendentes em tempo real
  if (authManager.userRole === 'admin') {
    startWatchingPendingLogins();
  }
}

// ══════════════════════════════════════════
// SISTEMA DE PERMISSÕES
// ══════════════════════════════════════════
function applyPermissions() {
  const role = authManager.userRole || 'usuario';

  const pageAccess = {
    dashboard:    ['admin', 'operador', 'usuario'],
    cadastro:     ['admin'],
    carteirinha:  ['admin'],
    leitor:       ['admin', 'operador', 'usuario'],
    historico:    ['admin', 'operador'],
    relatorios:   ['admin'],
    aprovacoes:   ['admin'],  // nova página de aprovações
  };

  document.querySelectorAll('[data-page]').forEach(btn => {
    const page = btn.dataset.page;
    const allowed = pageAccess[page] || [];
    btn.style.display = allowed.includes(role) ? '' : 'none';
  });

  // Badge de role
  const userEl = document.getElementById('user-name');
  if (userEl && !document.getElementById('role-badge')) {
    const roleLabel = { admin: 'Admin', operador: 'Operador', usuario: 'Usuário', aluno: 'Aluno' }[role] || role;
    const roleColor = { admin: 'var(--green)', operador: 'var(--blue)', usuario: 'var(--gray-500)', aluno: '#7c3aed' }[role];
    const badge = document.createElement('span');
    badge.id = 'role-badge';
    badge.style.cssText = `font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;background:${roleColor};color:white;margin-left:8px;text-transform:uppercase;letter-spacing:.05em;`;
    badge.textContent = roleLabel;
    userEl.parentNode.insertBefore(badge, userEl.nextSibling);
  }

  // Redirecionar se página ativa não é permitida
  const activePage = document.querySelector('.page.active');
  if (activePage) {
    const activeId = activePage.id.replace('page-', '');
    const allowed = pageAccess[activeId] || [];
    if (!allowed.includes(role)) showPage('dashboard');
  }

  const formCadastro = document.getElementById('form-cadastro');
  if (formCadastro && role !== 'admin') {
    formCadastro.querySelectorAll('input, select, button').forEach(el => el.disabled = true);
  }

  window._canManageStudents = (role === 'admin');
}

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.auth-form').forEach(f => {
    f.classList.remove('active');
    f.style.display = 'none';
  });

  const selectedBtn = document.querySelector(`[data-tab="${tab}"]`);
  const selectedForm = document.getElementById(`${tab}-form`);

  if (selectedBtn) selectedBtn.classList.add('active');
  if (selectedForm) {
    selectedForm.classList.add('active');
    selectedForm.style.display = 'block';
  }
}
window.switchAuthTab = switchAuthTab;

// ── Tela do aluno: exibe QR e info ──
function showAlunoScreen(aluno) {
  document.getElementById('auth-screen').style.display = 'none';
  const screen = document.getElementById('aluno-screen');
  screen.style.display = 'flex';

  document.getElementById('aluno-header-name').textContent = 'Olá, ' + aluno.nome.split(' ')[0] + '!';
  document.getElementById('aluno-info-nome').textContent = aluno.nome;
  document.getElementById('aluno-info-matricula').textContent = aluno.matricula;
  document.getElementById('aluno-info-turma').textContent = aluno.turma || '—';

  // Gerar QR code do aluno
  setTimeout(() => {
    const canvas = document.getElementById('aluno-qr-canvas');
    if (!canvas) return;
    const qrData = String(aluno.matricula).trim();
    drawQRToCanvas(canvas, qrData, '#085041', '#ffffff');
  }, 100);
}



// ══════════════════════════════════════════
// CARREGAMENTO DE DADOS
// ══════════════════════════════════════════
async function loadAll() {
  try {
    const loadingToast = toast.loading('Carregando dados...');
    await Promise.all([loadStudents(), loadLogs()]);
    updateStats();
    renderTable('');
    renderPickList('');
    renderDashboard();
    renderLogToday();
    loadingToast.close();
  } catch (e) {
    toast.error('Erro ao carregar dados: ' + e.message);
  }
}

async function loadStudents() {
  const snap = await getDocs(collection(db, 'alunos'));
  STUDENTS = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
}

async function loadLogs() {
  const snap = await getDocs(collection(db, 'refeicoes'));
  LOGS = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
}

// ══════════════════════════════════════════
// SISTEMA DE APROVAÇÃO DE LOGINS (ADMIN)
// ══════════════════════════════════════════
function startWatchingPendingLogins() {
  if (_pendingUnsubscribe) return;

  _pendingUnsubscribe = authManager.watchPendingLogins((list) => {
    updatePendingBadge(list.length);
    renderAprovacoes(list);
    const badge = document.getElementById('badge-login-count');
    if (badge) { badge.textContent = list.length; badge.style.display = list.length ? 'inline-flex' : 'none'; }
  });

  if (!_accessRequestsUnsubscribe) {
    _accessRequestsUnsubscribe = authManager.watchAccessRequests((list) => {
      renderAccessRequests(list);
      const badge = document.getElementById('badge-request-count');
      if (badge) { badge.textContent = list.length; badge.style.display = list.length ? 'inline-flex' : 'none'; }
    });
  }
}

function updatePendingBadge(count) {
  let badge = document.getElementById('aprovacoes-badge');
  const navBtn = document.querySelector('[data-page="aprovacoes"]');
  if (!navBtn) return;

  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'aprovacoes-badge';
    badge.style.cssText = `
      display:inline-flex;align-items:center;justify-content:center;
      background:#E53E3E;color:white;border-radius:50%;
      width:18px;height:18px;font-size:10px;font-weight:700;
      margin-left:auto;flex-shrink:0;
    `;
    navBtn.appendChild(badge);
  }

  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-flex';
    // Piscar levemente para chamar atenção
    navBtn.classList.add('has-pending');
  } else {
    badge.style.display = 'none';
    navBtn.classList.remove('has-pending');
  }
}

function renderAprovacoes(list) {
  const container = document.getElementById('aprovacoes-list');
  if (!container) return;

  if (!list.length) {
    container.innerHTML = `
      <div class="empty" style="padding:60px 0;">
        <i class="ti ti-check-circle" style="font-size:48px;color:var(--green);margin-bottom:8px;"></i>
        <p>Nenhum acesso pendente no momento</p>
      </div>`;
    return;
  }

  container.innerHTML = list.map(p => {
    const roleLabel = { admin: 'Admin', operador: 'Operador', usuario: 'Usuário' }[p.role] || p.role;
    const ts = p.solicitadoEm?.toDate ? p.solicitadoEm.toDate() : new Date();
    const timeStr = ts.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const dateStr = ts.toLocaleDateString('pt-BR');

    return `
      <div class="approval-card" id="approval-${p.uid}" data-uid="${p.uid}">
        <div class="approval-avatar">${initials(p.nome)}</div>
        <div class="approval-info">
          <div class="approval-name">${escapeHtml(p.nome)}</div>
          <div class="approval-email">${escapeHtml(p.email)}</div>
          <div class="approval-meta">
            <span class="badge" style="background:var(--gray-100);color:var(--gray-600);font-size:10px;">${roleLabel}</span>
            <span style="font-size:11px;color:var(--gray-400);">
              <i class="ti ti-clock"></i> ${dateStr} às ${timeStr}
            </span>
          </div>
        </div>
        <div class="approval-actions">
          <button class="btn btn-success btn-sm" onclick="handleApprove('${p.uid}')">
            <i class="ti ti-check"></i> Aceitar
          </button>
          <button class="btn btn-danger btn-sm" onclick="handleDeny('${p.uid}')">
            <i class="ti ti-x"></i> Recusar
          </button>
        </div>
      </div>`;
  }).join('');
}

window.handleApprove = async function(uid) {
  const card = document.getElementById(`approval-${uid}`);
  if (card) {
    card.style.opacity = '0.5';
    card.style.pointerEvents = 'none';
  }
  const result = await authManager.approveLogin(uid);
  if (result.success) {
    toast.success('Acesso aprovado!');
  } else {
    toast.error('Erro ao aprovar: ' + result.message);
    if (card) { card.style.opacity = '1'; card.style.pointerEvents = ''; }
  }
};

window.handleDeny = async function(uid) {
  if (!confirm('Recusar este acesso?')) return;
  const card = document.getElementById(`approval-${uid}`);
  if (card) {
    card.style.opacity = '0.5';
    card.style.pointerEvents = 'none';
  }
  const result = await authManager.denyLogin(uid);
  if (result.success) {
    toast.warning('Acesso recusado.');
  } else {
    toast.error('Erro ao recusar: ' + result.message);
    if (card) { card.style.opacity = '1'; card.style.pointerEvents = ''; }
  }
};

// ── Solicitações de acesso (novos usuários) ──
function renderAccessRequests(list) {
  const container = document.getElementById('access-requests-list');
  if (!container) return;

  if (!list.length) {
    container.innerHTML = `
      <div class="empty" style="padding:60px 0;">
        <i class="ti ti-inbox" style="font-size:48px;color:var(--green);margin-bottom:8px;"></i>
        <p>Nenhuma solicitação pendente</p>
      </div>`;
    return;
  }

  container.innerHTML = list.map(req => {
    const ts = req.solicitadoEm?.toDate ? req.solicitadoEm.toDate() : new Date();
    const timeStr = ts.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const dateStr = ts.toLocaleDateString('pt-BR');
    return `
      <div class="approval-card" id="access-req-${req._id}">
        <div class="approval-avatar">${initials(req.nome)}</div>
        <div class="approval-info">
          <div class="approval-name">${escapeHtml(req.nome)}</div>
          <div class="approval-email">${escapeHtml(req.email)}</div>
          <div class="approval-meta">
            <span style="font-size:11px;color:var(--gray-400);">
              <i class="ti ti-clock"></i> ${dateStr} às ${timeStr}
            </span>
          </div>
        </div>
        <div class="approval-actions">
          <select id="role-select-${req._id}" style="padding:6px 10px;border:1.5px solid var(--gray-100);border-radius:8px;font-size:12px;font-family:'DM Sans',sans-serif;">
            <option value="usuario">Usuário</option>
            <option value="operador">Operador</option>
            <option value="admin">Admin</option>
          </select>
          <button class="btn btn-success btn-sm" onclick="handleApproveRequest('${req._id}','${req.email}')">
            <i class="ti ti-check"></i> Aprovar
          </button>
          <button class="btn btn-danger btn-sm" onclick="handleDenyRequest('${req._id}')">
            <i class="ti ti-x"></i> Recusar
          </button>
        </div>
      </div>`;
  }).join('');
}

window.handleApproveRequest = async function(reqId, email) {
  const roleEl = document.getElementById(`role-select-${reqId}`);
  const role = roleEl ? roleEl.value : 'usuario';
  const card = document.getElementById(`access-req-${reqId}`);
  if (card) { card.style.opacity = '0.5'; card.style.pointerEvents = 'none'; }
  const result = await authManager.approveAccessRequest(reqId, email, role);
  if (result.success) {
    toast.success(`Acesso aprovado! ${email} já pode criar sua senha.`);
  } else {
    toast.error('Erro: ' + result.message);
    if (card) { card.style.opacity = '1'; card.style.pointerEvents = ''; }
  }
};

window.handleDenyRequest = async function(reqId) {
  if (!confirm('Recusar esta solicitação?')) return;
  const card = document.getElementById(`access-req-${reqId}`);
  if (card) { card.style.opacity = '0.5'; card.style.pointerEvents = 'none'; }
  const result = await authManager.denyAccessRequest(reqId);
  if (result.success) {
    toast.warning('Solicitação recusada.');
  } else {
    toast.error('Erro: ' + result.message);
    if (card) { card.style.opacity = '1'; card.style.pointerEvents = ''; }
  }
};



// ══════════════════════════════════════════
// EVENT LISTENERS
// ══════════════════════════════════════════
function setupEventListeners() {
  // ── Login de ALUNO por matrícula ──
  document.getElementById('aluno-login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const matricula = document.getElementById('aluno-matricula').value.trim();
    if (!matricula) { toast.error('Digite sua matrícula'); return; }

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    const loadingToast = toast.loading('Verificando matrícula...');
    try {
      const result = await authManager.loginAluno(matricula);
      loadingToast.close();
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      showAlunoScreen(result.aluno);
    } catch(err) {
      loadingToast.close();
      toast.error('Erro inesperado: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // Logout do aluno
  document.getElementById('btn-aluno-logout')?.addEventListener('click', () => {
    authManager.logoutAluno();
    document.getElementById('aluno-screen').style.display = 'none';
    document.getElementById('auth-screen').style.display = 'flex';
    document.getElementById('aluno-matricula').value = '';
  });

  // ── Solicitação de acesso (novo usuário sem conta) ──
  document.getElementById('request-access-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nome = document.getElementById('request-nome').value.trim();
    const email = document.getElementById('request-email').value.trim();

    const validNome = validators.nome(nome);
    if (!validNome.valid) { toast.error(validNome.msg); return; }
    const validEmail = validators.email(email);
    if (!validEmail.valid) { toast.error(validEmail.msg); return; }

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    const loadingToast = toast.loading('Enviando solicitação...');
    try {
      const result = await authManager.requestAccess(email, nome);
      loadingToast.close();
      if (result.success) {
        toast.success('Solicitação enviada! Aguarde a aprovação do administrador.');
        e.target.reset();
        switchAuthTab('login');
      } else {
        toast.error(result.message);
      }
    } catch(err) {
      loadingToast.close();
      toast.error('Erro: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // Navegação
  document.querySelectorAll('[data-page]').forEach(btn => {
    btn.addEventListener('click', () => showPage(btn.dataset.page));
  });

  // Hamburger
  document.getElementById('hamburger-btn')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });

  // Cadastro de aluno
  document.getElementById('form-cadastro')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await cadastrarAluno(new FormData(e.target));
  });

  // Busca de alunos
  document.getElementById('search-alunos')?.addEventListener('input', (e) => {
    renderTable(e.target.value);
  });

  // Carteirinha
  document.getElementById('search-carteirinha')?.addEventListener('input', (e) => {
    renderPickList(e.target.value);
  });

  // Leitor
  document.getElementById('btn-cam')?.addEventListener('click', toggleCam);
  document.getElementById('btn-manual')?.addEventListener('click', processManual);
  document.getElementById('manual-inp')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') processManual();
  });

  // Histórico
  document.getElementById('filter-date')?.addEventListener('change', renderHistorico);
  document.getElementById('hist-search')?.addEventListener('input', renderHistorico);
  document.getElementById('btn-clear-filters')?.addEventListener('click', () => {
    document.getElementById('filter-date').value = '';
    document.getElementById('hist-search').value = '';
    renderHistorico();
  });

  // Relatórios
  document.getElementById('btn-export-csv')?.addEventListener('click', () => {
    const data = LOGS.map(l => ({
      'Aluno': l.nome,
      'Matrícula': l.matricula,
      'Turma': l.turma,
      'Data': l.date,
      'Hora': fmtTime(l.timestamp),
      'Status': l.ok ? 'Servido' : 'Negado'
    }));
    exportToCSV(data, 'refeicoes');
  });

  document.getElementById('btn-report-turmas')?.addEventListener('click', renderReportTurmas);
  document.getElementById('btn-report-periodo')?.addEventListener('click', renderReportPeriodo);

  // ── AUTH ──

  // Login — FIX: trata pending
  document.getElementById('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const senha = document.getElementById('login-senha').value;
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    const loadingToast = toast.loading('Conectando...');
    try {
      const result = await authManager.login(email, senha);
      loadingToast.close();
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      // Se o login foi bem-sucedido, o auth state change exibirá a app.
    } finally {
      btn.disabled = false;
    }
  });

  // Cancelar espera de aprovação
  document.getElementById('btn-cancel-pending')?.addEventListener('click', () => {
    const uid = authManager.currentUser?.uid;
    if (uid) authManager.cancelPendingLogin(uid);
    document.getElementById('pending-screen').style.display = 'none';
    document.getElementById('auth-screen').style.display = 'flex';
    toast.info('Solicitação de acesso cancelada.');
  });

  // Signup
  document.getElementById('signup-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nome = document.getElementById('signup-nome').value.trim();
    const email = document.getElementById('signup-email').value.trim();
    const senha = document.getElementById('signup-senha').value;
    const senha2 = document.getElementById('signup-senha2').value;

    const validNome = validators.nome(nome);
    if (!validNome.valid) { toast.error(validNome.msg); return; }

    const validEmail = validators.email(email);
    if (!validEmail.valid) { toast.error(validEmail.msg); return; }

    const validSenha = validators.senha(senha);
    if (!validSenha.valid) { toast.error(validSenha.msg); return; }

    if (senha !== senha2) { toast.error('As senhas não conferem'); return; }

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    const loadingToast = toast.loading('Criando conta...');
    try {
      const result = await authManager.signup(email, senha, nome);
      loadingToast.close();
      if (result.success) {
        toast.success('Conta criada! Faça login para continuar.');
        switchAuthTab('login');
      } else {
        toast.error(result.message);
      }
    } finally {
      btn.disabled = false;
    }
  });

  // Trocar abas
  document.querySelectorAll('.auth-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => switchAuthTab(e.currentTarget.dataset.tab));
  });

  // Logout
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    if (!confirm('Sair da conta?')) return;
    if (_pendingUnsubscribe) { _pendingUnsubscribe(); _pendingUnsubscribe = null; }
    if (_accessRequestsUnsubscribe) { _accessRequestsUnsubscribe(); _accessRequestsUnsubscribe = null; }
    const result = await authManager.logout();
    if (result.success) {
      toast.success('Desconectado');
      STUDENTS = [];
      LOGS = [];
      // Remover badge de role se existir
      document.getElementById('role-badge')?.remove();
    }
  });

  // Recuperação de senha
  document.getElementById('btn-forgot')?.addEventListener('click', async () => {
    const email = document.getElementById('login-email').value.trim();
    if (!email) {
      toast.warning('Digite seu email no campo acima primeiro.');
      document.getElementById('login-email').focus();
      return;
    }
    const validEmail = validators.email(email);
    if (!validEmail.valid) { toast.error('Email inválido.'); return; }

    const btn = document.getElementById('btn-forgot');
    btn.disabled = true;
    const loadingToast = toast.loading('Enviando...');
    const result = await authManager.resetPassword(email);
    loadingToast.close();
    btn.disabled = false;

    if (result.success) {
      toast.success('Email de recuperação enviado! Verifique sua caixa de entrada.');
    } else {
      toast.error(result.message);
    }
  });

  // Força da senha em tempo real
  document.getElementById('signup-senha')?.addEventListener('input', (e) => {
    updatePasswordStrength(e.target.value);
  });
}

// ══════════════════════════════════════════
// FORÇA DE SENHA
// ══════════════════════════════════════════
function updatePasswordStrength(val) {
  const fill = document.getElementById('strength-fill');
  const label = document.getElementById('strength-label');
  if (!fill || !label) return;

  let score = 0;
  if (val.length >= 6) score++;
  if (val.length >= 10) score++;
  if (/[A-Z]/.test(val)) score++;
  if (/[0-9]/.test(val)) score++;
  if (/[^a-zA-Z0-9]/.test(val)) score++;

  const levels = [
    { pct: 0, color: 'transparent', text: '' },
    { pct: 20, color: '#A32D2D', text: 'Muito fraca' },
    { pct: 40, color: '#BA7517', text: 'Fraca' },
    { pct: 60, color: '#d4c014', text: 'Razoável' },
    { pct: 80, color: '#1D9E75', text: 'Forte' },
    { pct: 100, color: '#085041', text: 'Muito forte' },
  ];
  const lvl = val.length === 0 ? levels[0] : levels[score] || levels[4];

  fill.style.width = lvl.pct + '%';
  fill.style.background = lvl.color;
  label.textContent = lvl.text;
  label.style.color = lvl.color;
}

// ══════════════════════════════════════════
// NAVEGAÇÃO
// ══════════════════════════════════════════
const PAGE_TITLES = {
  dashboard:  'Dashboard',
  cadastro:   'Alunos',
  carteirinha:'Carteirinhas',
  leitor:     'Leitor QR',
  historico:  'Histórico',
  relatorios: 'Relatórios',
  aprovacoes: 'Aprovações de Acesso',
};

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('[data-page]').forEach(b => b.classList.remove('active'));

  document.getElementById('page-' + id)?.classList.add('active');
  document.querySelector(`[data-page="${id}"]`)?.classList.add('active');
  document.getElementById('topbar-title').textContent = PAGE_TITLES[id] || id;

  if (id === 'historico') renderHistorico();
  if (id === 'leitor') renderLogToday();

  if (window.innerWidth <= 900) {
    document.getElementById('sidebar').classList.remove('open');
  }
}

// ══════════════════════════════════════════
// STATS
// ══════════════════════════════════════════
function updateStats() {
  const todayLogs = LOGS.filter(l => l.date === today());
  const okToday = todayLogs.filter(l => l.ok).map(l => l.matricula);
  const denToday = todayLogs.filter(l => !l.ok).length;

  document.getElementById('d-total').textContent = STUDENTS.length;
  document.getElementById('d-today').textContent = new Set(okToday).size;
  document.getElementById('d-pend').textContent = STUDENTS.length - new Set(okToday).size;
  document.getElementById('d-denied').textContent = denToday;
}

// ══════════════════════════════════════════
// CADASTRO
// ══════════════════════════════════════════
async function cadastrarAluno(formData) {
  const nome = formData.get('nome').trim();
  const matricula = formData.get('matricula').trim();
  const turma = formData.get('turma');
  const responsavel = (formData.get('responsavel') || '').trim();

  const validNome = validators.nome(nome);
  const validMat = validators.matricula(matricula);
  const validTurma = validators.turma(turma);

  if (!validNome.valid) { toast.error(validNome.msg); return; }
  if (!validMat.valid) { toast.error(validMat.msg); return; }
  if (!validTurma.valid) { toast.error(validTurma.msg); return; }

  if (STUDENTS.find(a => a.matricula === matricula)) {
    toast.error('Matrícula já cadastrada!');
    return;
  }

  try {
    const loadingToast = toast.loading('Cadastrando...');
    const ref = await addDoc(collection(db, 'alunos'), {
      nome, matricula, turma, responsavel,
      criadoEm: serverTimestamp()
    });

    STUDENTS.push({ _id: ref.id, nome, matricula, turma, responsavel });
    updateStats();
    renderTable('');
    renderPickList('');
    renderDashboard();
    document.getElementById('form-cadastro').reset();
    loadingToast.close();
    toast.success('Aluno cadastrado com sucesso!');
  } catch (e) {
    toast.error('Erro: ' + e.message);
  }
}

async function removerAluno(id) {
  if (!confirm('Remover este aluno do sistema?')) return;
  try {
    const loadingToast = toast.loading('Removendo...');
    await deleteDoc(doc(db, 'alunos', id));
    STUDENTS = STUDENTS.filter(a => a._id !== id);
    updateStats();
    renderTable('');
    renderPickList('');
    renderDashboard();
    loadingToast.close();
    toast.success('Aluno removido');
  } catch (e) {
    toast.error('Erro ao remover: ' + e.message);
  }
}

function renderTable(filter = '') {
  const tbody = document.getElementById('student-tbody');
  const okToday = new Set(LOGS.filter(l => l.date === today() && l.ok).map(l => l.matricula));

  let list = STUDENTS;
  if (filter) {
    list = list.filter(a =>
      a.nome.toLowerCase().includes(filter.toLowerCase()) ||
      a.matricula.includes(filter)
    );
  }

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty"><i class="ti ti-users"></i><p>Nenhum aluno encontrado</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = list.map((a, i) => {
    const [bg, fg] = getColor(i);
    const used = okToday.has(a.matricula);
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:10px;">
        <div class="avatar" style="background:${fg};color:${bg}">${initials(a.nome)}</div>
        <span style="font-weight:500">${escapeHtml(a.nome)}</span>
      </div></td>
      <td style="color:var(--gray-500)">${escapeHtml(a.matricula)}</td>
      <td>${escapeHtml(a.turma || '—')}</td>
      <td><span class="badge ${used ? 'badge-ok' : 'badge-pend'}">${used ? '✓ Servido' : 'Pendente'}</span></td>
      <td>
        ${window._canManageStudents ? `<button class="btn btn-danger btn-sm" data-id="${a._id}"><i class="ti ti-trash"></i></button>` : ''}
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.btn-danger[data-id]').forEach(btn => {
    btn.addEventListener('click', () => removerAluno(btn.dataset.id));
  });
}

// ══════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════
function renderDashboard() {
  updateStats();

  const recent = LOGS.filter(l => l.ok)
    .sort((a, b) => {
      const ta = a.timestamp?.toDate?.() || new Date(0);
      const tb = b.timestamp?.toDate?.() || new Date(0);
      return tb - ta;
    })
    .slice(0, 6);

  const dashRecent = document.getElementById('dash-recent');
  if (!recent.length) {
    dashRecent.innerHTML = `<div class="empty"><i class="ti ti-coffee"></i><p>Nenhuma refeição registrada</p></div>`;
  } else {
    dashRecent.innerHTML = recent.map((l, i) => {
      const [bg, fg] = getColor(i);
      return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--gray-100)">
        <div class="avatar" style="background:${fg};color:${bg};width:32px;height:32px;font-size:11px;">${initials(l.nome)}</div>
        <div style="flex:1;font-size:13px;font-weight:500">${escapeHtml(l.nome)}</div>
        <div style="font-size:11px;color:var(--gray-500)">${fmtTime(l.timestamp)}</div>
      </div>`;
    }).join('');
  }

  const turmaMap = {};
  LOGS.filter(l => l.date === today() && l.ok).forEach(l => {
    turmaMap[l.turma] = (turmaMap[l.turma] || 0) + 1;
  });

  const dashTurmas = document.getElementById('dash-turmas');
  if (!Object.keys(turmaMap).length) {
    dashTurmas.innerHTML = `<div class="empty"><i class="ti ti-school"></i><p>Nenhum dado hoje</p></div>`;
  } else {
    const max = Math.max(...Object.values(turmaMap));
    dashTurmas.innerHTML = Object.entries(turmaMap)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `
        <div style="margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">
            <span>${escapeHtml(t)}</span><span style="color:var(--gray-500)">${n}</span>
          </div>
          <div style="height:6px;background:var(--gray-100);border-radius:4px;overflow:hidden;">
            <div style="height:100%;width:${Math.round(n / max * 100)}%;background:var(--green);border-radius:4px;"></div>
          </div>
        </div>`).join('');
  }
}

// ══════════════════════════════════════════
// CARTEIRINHA
// ══════════════════════════════════════════
function renderPickList(filter = '') {
  const el = document.getElementById('pick-list');
  let list = STUDENTS;

  if (filter) {
    list = list.filter(a =>
      a.nome.toLowerCase().includes(filter.toLowerCase()) ||
      a.matricula.includes(filter)
    );
  }

  if (!list.length) {
    el.innerHTML = `<div class="empty"><i class="ti ti-users"></i><p>${filter ? 'Nenhum encontrado' : 'Nenhum aluno cadastrado'}</p></div>`;
    return;
  }

  el.innerHTML = list.map((a, i) => {
    const [bg, fg] = getColor(i);
    const sel = selectedStudent && selectedStudent._id === a._id;
    return `<div class="pick-item ${sel ? 'selected' : ''}" data-id="${a._id}">
      <div class="avatar" style="background:${fg};color:${bg}">${initials(a.nome)}</div>
      <div class="pick-info">
        <div class="pick-name">${escapeHtml(a.nome)}</div>
        <div class="pick-meta">${escapeHtml(a.matricula)} · ${escapeHtml(a.turma)}</div>
      </div>
      <i class="ti ti-chevron-right" style="color:var(--gray-300)"></i>
    </div>`;
  }).join('');

  el.querySelectorAll('.pick-item[data-id]').forEach(item => {
    item.addEventListener('click', () => selectForCard(item.dataset.id));
  });
}

window.selectForCard = function(id) {
  selectedStudent = STUDENTS.find(a => a._id === id);
  renderPickList('');
  renderCarteirinha();
};

function renderCarteirinha() {
  if (!selectedStudent) return;
  const a = selectedStudent;
  const qrData = JSON.stringify({ mat: a.matricula, nome: a.nome, turma: a.turma });
  const el = document.getElementById('carteirinha-display');

  el.innerHTML = `
    <div class="carteirinha">
      <div class="c-school"><i class="ti ti-school"></i> ${schoolConfig.name}</div>
      <div class="c-body">
        <div class="c-qr-wrap"><canvas id="qr-canvas" width="108" height="108"></canvas></div>
        <div class="c-info">
          <div class="c-name">${escapeHtml(a.nome.split(' ')[0])}</div>
          <div class="c-field"><div class="c-label">Nome completo</div><div class="c-val">${escapeHtml(a.nome)}</div></div>
          <div class="c-field"><div class="c-label">Matrícula</div><div class="c-val">${escapeHtml(a.matricula)}</div></div>
          <div class="c-field"><div class="c-label">Turma</div><div class="c-val">${escapeHtml(a.turma)}</div></div>
        </div>
      </div>
      <div class="c-footer">
        <span>Válido para ${schoolConfig.year}</span>
        <span>CantinaSmart</span>
      </div>
    </div>
    <button class="btn btn-ghost" style="margin-top:12px;width:100%;" onclick="window.print()">
      <i class="ti ti-printer"></i> Imprimir carteirinha
    </button>`;

  setTimeout(() => {
    const canvas = document.getElementById('qr-canvas');
    if (!canvas) return;
    const qrData = String(a.matricula).trim();
    drawQRToCanvas(canvas, qrData, '#085041', '#ffffff');
  }, 50);
}

function drawQRToCanvas(canvas, text, dark = '#000', light = '#fff') {
  try {
    if (window.qrcode) {
      const qr = window.qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      const size = Math.min(canvas.width, canvas.height);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      const cells = qr.getModuleCount();
      const cellSize = size / cells;
      ctx.fillStyle = light;
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = dark;
      for (let r = 0; r < cells; r++) {
        for (let c = 0; c < cells; c++) {
          if (qr.isDark(r, c)) {
            ctx.fillRect(
              Math.floor(c * cellSize),
              Math.floor(r * cellSize),
              Math.ceil(cellSize),
              Math.ceil(cellSize)
            );
          }
        }
      }
      return;
    }
    if (window.QRCode) {
      const div = document.createElement('div');
      new window.QRCode(div, { text, width: canvas.width, height: canvas.height,
        colorDark: dark, colorLight: light, correctLevel: window.QRCode.CorrectLevel.M });
      setTimeout(() => {
        const img = div.querySelector('img') || div.querySelector('canvas');
        if (img) {
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        }
      }, 200);
      return;
    }
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = dark;
    ctx.font = '9px monospace';
    ctx.fillText('QR indisponível', 4, canvas.height / 2);
  } catch(e) {
    console.error('Erro ao gerar QR:', e);
  }
}

// ══════════════════════════════════════════
// LEITOR
// ══════════════════════════════════════════
async function processRefeicao(mat) {
  const normalizedMat = String(mat).trim();
  const aluno = STUDENTS.find(a => String(a.matricula).trim() === normalizedMat);
  const box = document.getElementById('result-box');
  box.className = 'result-box';

  if (!aluno) {
    box.classList.add('error');
    box.style.display = 'block';
    document.getElementById('result-icon').textContent = '❌';
    document.getElementById('result-title').textContent = 'Aluno não encontrado';
    document.getElementById('result-sub').textContent = `Matrícula "${escapeHtml(normalizedMat)}" não está cadastrada.`;
    await addLog({ matricula: normalizedMat, nome: '—', turma: '—', ok: false, msg: 'Não cadastrado' });
    return;
  }

  const usedToday = LOGS.find(l => String(l.matricula).trim() === normalizedMat && l.date === today() && l.ok);

  if (usedToday) {
    box.classList.add('warning');
    box.style.display = 'block';
    document.getElementById('result-icon').textContent = '⚠️';
    document.getElementById('result-title').textContent = 'Refeição já registrada!';
    document.getElementById('result-sub').textContent = `${escapeHtml(aluno.nome)} já foi servido às ${fmtTime(usedToday.timestamp)}.`;
    await addLog({ matricula: normalizedMat, nome: aluno.nome, turma: aluno.turma, ok: false, msg: 'Dupla tentativa' });
    return;
  }

  box.classList.add('success');
  box.style.display = 'block';
  document.getElementById('result-icon').textContent = '✅';
  document.getElementById('result-title').textContent = 'Refeição liberada!';
  document.getElementById('result-sub').textContent = `${escapeHtml(aluno.nome)} — ${escapeHtml(aluno.turma)}`;

  await addLog({ matricula: normalizedMat, nome: aluno.nome, turma: aluno.turma, ok: true, msg: 'OK' });
  updateStats();
  renderTable('');
  renderDashboard();
}

async function addLog(data) {
  const log = { ...data, date: today(), timestamp: serverTimestamp() };
  try {
    const ref = await addDoc(collection(db, 'refeicoes'), log);
    LOGS.push({ _id: ref.id, ...log, timestamp: { toDate: () => new Date() } });
  } catch (e) {
    toast.error('Erro ao registrar: ' + e.message);
  }
  renderLogToday();
}

function renderLogToday() {
  const el = document.getElementById('log-today');
  const todayLogs = LOGS.filter(l => l.date === today()).reverse();

  if (!todayLogs.length) {
    el.innerHTML = `<div class="empty"><i class="ti ti-coffee"></i><p>Nenhuma leitura ainda hoje</p></div>`;
    return;
  }

  el.innerHTML = todayLogs.map((l, i) => {
    const [bg, fg] = getColor(i);
    return `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--gray-100);">
      <div class="avatar" style="background:${fg};color:${bg};width:30px;height:30px;font-size:10px;flex-shrink:0">${initials(l.nome)}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(l.nome)}</div>
        <div style="font-size:11px;color:var(--gray-500)">${escapeHtml(l.turma || '')}</div>
      </div>
      <span class="badge ${l.ok ? 'badge-ok' : 'badge-denied'}">${l.ok ? 'OK' : 'Negado'}</span>
      <span style="font-size:11px;color:var(--gray-500);flex-shrink:0">${fmtTime(l.timestamp)}</span>
    </div>`;
  }).join('');
}

function processManual() {
  const val = document.getElementById('manual-inp').value.trim();
  if (!val) return;
  processRefeicao(val);
  document.getElementById('manual-inp').value = '';
}

// ── Camera ──
function toggleCam() {
  const btn = document.getElementById('btn-cam');
  const video = document.getElementById('video');
  const idle = document.getElementById('cam-idle');

  if (camStream) {
    camStream.getTracks().forEach(t => t.stop());
    camStream = null;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    _scanCanvas = null; _scanCtx = null; // reset cache
    video.srcObject = null;
    video.style.display = 'none';
    idle.style.display = 'flex';
    btn.innerHTML = '<i class="ti ti-camera"></i> Ativar câmera';
    btn.className = 'btn btn-primary';
    return;
  }

  const constraints = {
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 }
    }
  };

  navigator.mediaDevices.getUserMedia(constraints)
    .catch(err => {
      if (err.name === 'OverconstrainedError' || err.name === 'NotReadableError' || err.name === 'NotFoundError') {
        return navigator.mediaDevices.getUserMedia({ video: true });
      }
      throw err;
    })
    .then(stream => {
      camStream = stream;
      video.srcObject = stream;
      video.playsInline = true;
      video.muted = true;
      video.style.display = 'block';
      idle.style.display = 'none';
      btn.innerHTML = '<i class="ti ti-x"></i> Parar câmera';
      btn.className = 'btn btn-danger';
      _scanCanvas = null; _scanCtx = null; // reset cache

      // Espera o video estar pronto para começar scan
      video.onloadedmetadata = () => {
        video.play().then(() => scheduleScan()).catch(() => scheduleScan());
      };
      // Fallback se o evento já foi disparado
      if (video.readyState >= 2) {
        video.play().then(() => scheduleScan()).catch(() => scheduleScan());
      }
    })
    .catch((err) => {
      console.error('Erro câmera:', err);
      toast.error('Não foi possível acessar a câmera. Verifique permissões e use HTTPS.');
    });
}

let lastScan = 0;
let _scanCanvas = null;
let _scanCtx = null;

function scheduleScan() {
  rafId = requestAnimationFrame((ts) => {
    if (!camStream) return;
    if (ts - lastScan > 300) {
      lastScan = ts;
      scanQR();
    }
    scheduleScan();
  });
}

function scanQR() {
  const video = document.getElementById('video');
  if (!video) return;
  if (video.readyState < 2 || video.paused || video.ended) return;
  if (!video.videoWidth || !video.videoHeight) return;

  // Reutiliza canvas para performance
  if (!_scanCanvas) {
    _scanCanvas = document.getElementById('scanCanvas');
    if (!_scanCanvas) return;
    _scanCtx = _scanCanvas.getContext('2d', { willReadFrequently: true });
  }

  const w = video.videoWidth;
  const h = video.videoHeight;
  const scanSize = Math.min(w, h, 800);
  if (_scanCanvas.width !== scanSize || _scanCanvas.height !== scanSize) {
    _scanCanvas.width = scanSize;
    _scanCanvas.height = scanSize;
  }

  try {
    const sx = Math.max(0, (w - scanSize) / 2);
    const sy = Math.max(0, (h - scanSize) / 2);
    _scanCtx.drawImage(video, sx, sy, scanSize, scanSize, 0, 0, scanSize, scanSize);
  } catch { return; }

  let img;
  try {
    img = _scanCtx.getImageData(0, 0, scanSize, scanSize);
  } catch { return; }

  if (!window.jsQR) {
    console.warn('jsQR não carregado ainda');
    return;
  }

  const code = window.jsQR(img.data, img.width, img.height, {
    inversionAttempts: 'attemptBoth'
  });

  if (code && !scanning) {
    scanning = true;
    const raw = code.data;
    try {
      const d = JSON.parse(raw);
      processRefeicao(d.mat || raw);
    } catch {
      processRefeicao(raw);
    }
    setTimeout(() => { scanning = false; }, 3000);
  }
}

// ══════════════════════════════════════════
// HISTÓRICO
// ══════════════════════════════════════════
function renderHistorico() {
  const dateFilter = document.getElementById('filter-date').value;
  const searchFilter = (document.getElementById('hist-search').value || '').toLowerCase();
  const tbody = document.getElementById('hist-tbody');

  let list = [...LOGS].sort((a, b) => {
    const ta = a.timestamp?.toDate?.() || new Date(0);
    const tb = b.timestamp?.toDate?.() || new Date(0);
    return tb - ta;
  });

  if (dateFilter) list = list.filter(l => l.date === dateFilter);
  if (searchFilter) list = list.filter(l => (l.nome || '').toLowerCase().includes(searchFilter));

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty"><i class="ti ti-history"></i><p>Nenhum registro encontrado</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = list.map((l, i) => {
    const [bg, fg] = getColor(i);
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:8px;">
        <div class="avatar" style="background:${fg};color:${bg};width:30px;height:30px;font-size:10px">${initials(l.nome)}</div>
        <span>${escapeHtml(l.nome)}</span>
      </div></td>
      <td style="color:var(--gray-500)">${escapeHtml(l.matricula)}</td>
      <td>${escapeHtml(l.turma || '—')}</td>
      <td>${escapeHtml(l.date || '—')}</td>
      <td>${fmtTime(l.timestamp)}</td>
      <td><span class="badge ${l.ok ? 'badge-ok' : 'badge-denied'}">${l.ok ? '✓ Servido' : '✗ Negado'}</span></td>
    </tr>`;
  }).join('');
}

// ══════════════════════════════════════════
// RELATÓRIOS
// ══════════════════════════════════════════
function renderReportTurmas() {
  const reportContainer = document.getElementById('report-container');
  const turmaData = {};

  LOGS.filter(l => l.ok).forEach(l => {
    if (!turmaData[l.turma]) turmaData[l.turma] = { total: 0, unique: new Set() };
    turmaData[l.turma].total += 1;
    turmaData[l.turma].unique.add(l.matricula);
  });

  const sorted = Object.entries(turmaData)
    .map(([turma, data]) => ({ turma, total: data.total, alunos: data.unique.size }))
    .sort((a, b) => b.total - a.total);

  reportContainer.innerHTML = `
    <div class="card">
      <div class="card-title"><i class="ti ti-chart-pie"></i> Refeições por turma</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Turma</th><th>Total de refeições</th><th>Alunos únicos</th><th>Média</th></tr></thead>
          <tbody>
            ${sorted.map(d => `<tr>
              <td>${escapeHtml(d.turma)}</td>
              <td>${d.total}</td>
              <td>${d.alunos}</td>
              <td>${(d.total / d.alunos).toFixed(1)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderReportPeriodo() {
  const reportContainer = document.getElementById('report-container');
  const periodoData = {};

  LOGS.filter(l => l.ok).forEach(l => {
    if (!periodoData[l.date]) periodoData[l.date] = { total: 0, unique: new Set() };
    periodoData[l.date].total += 1;
    periodoData[l.date].unique.add(l.matricula);
  });

  const sorted = Object.entries(periodoData)
    .map(([date, data]) => ({ date, total: data.total, alunos: data.unique.size }))
    .sort((a, b) => b.date.localeCompare(a.date));

  reportContainer.innerHTML = `
    <div class="card">
      <div class="card-title"><i class="ti ti-calendar"></i> Refeições por período</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Data</th><th>Total de refeições</th><th>Alunos únicos</th></tr></thead>
          <tbody>
            ${sorted.map(d => `<tr>
              <td>${fmtDate(d.date)}</td>
              <td>${d.total}</td>
              <td>${d.alunos}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

// ══════════════════════════════════════════
// UTILITÁRIOS
// ══════════════════════════════════════════
function updateDateBadge() {
  const badge = document.getElementById('date-badge');
  if (badge) {
    badge.textContent = new Date().toLocaleDateString('pt-BR', {
      weekday: 'long', day: 'numeric', month: 'long'
    });
  }
  setTimeout(updateDateBadge, 60000);
}

window.removerAluno = removerAluno;
window.selectForCard = selectForCard;
