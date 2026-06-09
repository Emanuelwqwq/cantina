// Autenticação Firebase e gerenciamento de sessão

import { 
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  sendPasswordResetEmail,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  doc, getDoc, setDoc, getDocs, collection, serverTimestamp,
  onSnapshot, updateDoc, query, where, deleteDoc, addDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export class AuthManager {
  constructor(auth, db) {
    this.auth = auth;
    this.db = db;
    this.currentUser = null;
    this.userRole = null;
    this.userName = null;
    this.studentData = null;   // dados do aluno logado via matrícula
    this._pendingUnsubscribe = null;
    this.initPersistence();
  }

  async initPersistence() {
    try {
      await setPersistence(this.auth, browserLocalPersistence);
    } catch (e) {
      console.error('Erro ao inicializar persistência:', e);
    }
  }

  // ── Verificar se email está na whitelist de autorizados ──
  async _isEmailAuthorized(email) {
    try {
      const snap = await getDoc(doc(this.db, 'authorized_emails', email.toLowerCase()));
      return snap.exists();
    } catch (e) {
      console.error('Erro ao verificar autorização:', e);
      return false;
    }
  }

  // ── Login de ALUNO por matrícula (sem Firebase Auth) ──
  // Usa getDocs na coleção inteira para evitar exigir índice no Firestore
  async loginAluno(matricula) {
    try {
      const mat = matricula.trim();
      // Tenta query direta primeiro (funciona se regra permitir)
      let alunoData = null;
      try {
        const q = query(collection(this.db, 'alunos'), where('matricula', '==', mat));
        const snap = await getDocs(q);
        if (!snap.empty) {
          alunoData = { _id: snap.docs[0].id, ...snap.docs[0].data() };
        }
      } catch (e) {
        // Se falhar (ex: regra de segurança ou índice), retorna erro claro
        return { success: false, message: 'Erro de permissão: verifique as regras do Firestore. ' + e.message };
      }

      if (!alunoData) {
        return { success: false, message: 'Matrícula não encontrada. Verifique o número informado.' };
      }

      this.studentData = alunoData;
      this.userRole = 'aluno';
      this.userName = alunoData.nome;
      this.currentUser = { uid: 'aluno_' + mat, isAnonymous: true };
      return { success: true, aluno: alunoData };
    } catch (e) {
      return { success: false, message: 'Erro: ' + e.message };
    }
  }

  // Logout de aluno (sem Firebase Auth)
  logoutAluno() {
    this.studentData = null;
    this.userRole = null;
    this.userName = null;
    this.currentUser = null;
  }

  // ── Solicitar acesso (envia pedido ao admin sem criar conta) ──
  async requestAccess(email, nome) {
    try {
      const normalizedEmail = email.trim().toLowerCase();
      // Grava diretamente — duplicatas são gerenciadas pelo admin
      // (query composta com 2 where exige índice no Firestore, evitamos aqui)
      await addDoc(collection(this.db, 'access_requests'), {
        email: normalizedEmail,
        nome: nome,
        status: 'pending',
        solicitadoEm: serverTimestamp()
      });
      return { success: true };
    } catch (e) {
      return { success: false, message: 'Erro ao enviar solicitação: ' + e.message };
    }
  }

  // ── Admin: ver solicitações de acesso pendentes ──
  watchAccessRequests(callback) {
    const q = query(
      collection(this.db, 'access_requests'),
      where('status', '==', 'pending')
    );
    return onSnapshot(q, (snap) => {
      const list = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
      callback(list);
    });
  }

  // ── Admin: aprovar solicitação de acesso (adiciona email à whitelist) ──
  async approveAccessRequest(requestId, email, role = 'usuario') {
    try {
      await setDoc(doc(this.db, 'authorized_emails', email.toLowerCase()), {
        role: role,
        autorizadoEm: serverTimestamp()
      });
      await updateDoc(doc(this.db, 'access_requests', requestId), {
        status: 'approved',
        resolvidoEm: serverTimestamp()
      });
      return { success: true };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // ── Admin: recusar solicitação de acesso ──
  async denyAccessRequest(requestId) {
    try {
      await updateDoc(doc(this.db, 'access_requests', requestId), {
        status: 'denied',
        resolvidoEm: serverTimestamp()
      });
      return { success: true };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }


  async signup(email, senha, nome) {
    try {
      const normalizedEmail = email.trim().toLowerCase();
      const authorized = await this._isEmailAuthorized(normalizedEmail);
      if (!authorized) {
        return {
          success: false,
          message: 'Este email não está autorizado a criar conta. Solicite acesso ao administrador.'
        };
      }

      const userCred = await createUserWithEmailAndPassword(this.auth, normalizedEmail, senha);
      await updateProfile(userCred.user, { displayName: nome });

      const authDoc = await getDoc(doc(this.db, 'authorized_emails', normalizedEmail));
      const preRole = authDoc.data()?.role || 'usuario';

      await setDoc(doc(this.db, 'users', userCred.user.uid), {
        uid: userCred.user.uid,
        email: normalizedEmail,
        nome: nome,
        role: preRole,
        criadoEm: serverTimestamp(),
        ultimoAcesso: serverTimestamp()
      });

      this.currentUser = userCred.user;
      return { success: true };
    } catch (error) {
      return { success: false, message: this._getErrorMessage(error.code) };
    }
  }

  // ──────────────────────────────────────────────────────────────
  // LOGIN direto
  // Fluxo:
  //   1. Autentica no Firebase Auth normalmente
  //   2. Atualiza último acesso no Firestore
  //   3. Não bloqueia login em fila para usuários autorizados
  // ──────────────────────────────────────────────────────────────
  async login(email, senha) {
    try {
      const normalizedEmail = email.trim().toLowerCase();
      const userCred = await signInWithEmailAndPassword(this.auth, normalizedEmail, senha);

      await setDoc(doc(this.db, 'users', userCred.user.uid), {
        ultimoAcesso: serverTimestamp()
      }, { merge: true });

      this.currentUser = userCred.user;
      await this._loadUserData();

      // Usuários autorizados acessam direto; não bloqueamos o login em fila.
      return { success: true, pending: false };
    } catch (error) {
      return { success: false, message: this._getErrorMessage(error.code) };
    }
  }

  // ── Escutar resultado da aprovação (chama callback com 'approved' | 'denied') ──
  waitForApproval(uid, callback) {
    // Cancela listener anterior se houver
    if (this._pendingUnsubscribe) this._pendingUnsubscribe();

    const ref = doc(this.db, 'pending_logins', uid);
    this._pendingUnsubscribe = onSnapshot(ref, (snap) => {
      if (!snap.exists()) return;
      const status = snap.data().status;
      if (status === 'approved' || status === 'denied') {
        if (this._pendingUnsubscribe) {
          this._pendingUnsubscribe();
          this._pendingUnsubscribe = null;
        }
        callback(status);
      }
    });
  }

  // ── Cancelar espera (ex: usuário fechou a aba de espera) ──
  cancelPendingLogin(uid) {
    if (this._pendingUnsubscribe) {
      this._pendingUnsubscribe();
      this._pendingUnsubscribe = null;
    }
    // Remove da fila
    deleteDoc(doc(this.db, 'pending_logins', uid)).catch(() => {});
    signOut(this.auth).catch(() => {});
  }

  // ── Admin: buscar todos os logins pendentes em tempo real ──
  watchPendingLogins(callback) {
    const q = query(
      collection(this.db, 'pending_logins'),
      where('status', '==', 'pending')
    );
    return onSnapshot(q, (snap) => {
      const list = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
      callback(list);
    });
  }

  // ── Admin: aprovar login ──
  async approveLogin(uid) {
    try {
      await updateDoc(doc(this.db, 'pending_logins', uid), {
        status: 'approved',
        resolvidoEm: serverTimestamp()
      });
      return { success: true };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // ── Admin: recusar login ──
  async denyLogin(uid) {
    try {
      await updateDoc(doc(this.db, 'pending_logins', uid), {
        status: 'denied',
        resolvidoEm: serverTimestamp()
      });
      return { success: true };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // Logout
  async logout() {
    try {
      // Limpa listener de aprovação se houver
      if (this._pendingUnsubscribe) {
        this._pendingUnsubscribe();
        this._pendingUnsubscribe = null;
      }
      await signOut(this.auth);
      this.currentUser = null;
      this.userRole = null;
      this.userName = null;
      return { success: true };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  // Recuperação de senha
  async resetPassword(email) {
    try {
      await sendPasswordResetEmail(this.auth, email);
      return { success: true };
    } catch (error) {
      return { success: false, message: this._getErrorMessage(error.code) };
    }
  }

  // ── FIX: _loadUserData agora retorna uma Promise que resolve após carregar ──
  async _loadUserData() {
    if (!this.currentUser) return;
    try {
      const docRef = doc(this.db, 'users', this.currentUser.uid);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const data = docSnap.data();
        this.userRole = data.role || 'usuario';
        this.userName = data.nome || this.currentUser.displayName || this.currentUser.email.split('@')[0];
      }
    } catch (e) {
      console.error('Erro ao carregar dados do usuário:', e);
    }
  }

  async _loadUserRole() { return this._loadUserData(); }

  // ── FIX: onAuthChange agora aguarda _loadUserData antes de chamar o callback ──
  onAuthChange(callback) {
    return onAuthStateChanged(this.auth, async (user) => {
      this.currentUser = user;
      if (user) {
        await this._loadUserData(); // aguarda role carregar ANTES de chamar callback
      }
      callback(user);
    });
  }

  hasPermission(requiredRole) {
    if (!this.currentUser) return false;
    const roleHierarchy = { admin: 3, operador: 2, usuario: 1 };
    return (roleHierarchy[this.userRole] || 0) >= (roleHierarchy[requiredRole] || 0);
  }

  _getErrorMessage(code) {
    const messages = {
      'auth/email-already-in-use': 'Este email já está cadastrado',
      'auth/weak-password': 'Senha muito fraca (mínimo 6 caracteres)',
      'auth/invalid-email': 'Email inválido',
      'auth/user-not-found': 'Email não encontrado',
      'auth/wrong-password': 'Senha incorreta',
      'auth/invalid-credential': 'Email ou senha incorretos',
      'auth/too-many-requests': 'Muitas tentativas. Tente novamente mais tarde.',
      'auth/network-request-failed': 'Erro de conexão. Verifique sua internet.',
      'auth/operation-not-allowed': 'Operação não permitida'
    };
    return messages[code] || 'Erro de autenticação';
  }
}
