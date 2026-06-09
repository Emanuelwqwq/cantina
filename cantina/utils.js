// Validadores e funções utilitárias

export const TURMAS = [
  '1º EM Desenvolvimento de Sistemas A',
  '1º EM Desenvolvimento de Sistemas B',
  '2º EM Desenvolvimento de Sistemas',
  '2º EM Marketing Digital',
];

export const validators = {
  nome: (val) => {
    const cleaned = (val || '').trim();
    if (cleaned.length < 3) return { valid: false, msg: 'Nome deve ter pelo menos 3 caracteres' };
    if (!/^[a-záéíóúãõç\s]+$/i.test(cleaned)) return { valid: false, msg: 'Nome não pode conter números' };
    return { valid: true };
  },

  // FIX: limite aumentado para 15 dígitos
  matricula: (val) => {
    const cleaned = (val || '').trim();
    if (!/^\d{4,15}$/.test(cleaned)) return { valid: false, msg: 'Matrícula deve ter entre 4 e 15 números' };
    return { valid: true };
  },

  email: (val) => {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!re.test(val)) return { valid: false, msg: 'Email inválido' };
    return { valid: true };
  },

  senha: (val) => {
    if (val.length < 6) return { valid: false, msg: 'Senha deve ter pelo menos 6 caracteres' };
    if (!/[a-z]/i.test(val)) return { valid: false, msg: 'Senha precisa de letras' };
    if (!/[0-9]/.test(val)) return { valid: false, msg: 'Senha precisa de números' };
    return { valid: true };
  },

  turma: (val) => {
    if (!val) return { valid: false, msg: 'Selecione uma turma' };
    return { valid: true };
  }
};

export const fmtDate = (ts) => {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('pt-BR');
};

export const fmtTime = (ts) => {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
};

export const initials = (name) => {
  return (name || '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(n => n[0].toUpperCase())
    .join('');
};

export const today = () => new Date().toISOString().split('T')[0];

export const PALETTE = [
  ['#085041', '#E1F5EE'],
  ['#185FA5', '#E6F1FB'],
  ['#533AB7', '#EEEDFE'],
  ['#993556', '#FBEAF0'],
  ['#854F0B', '#FAEEDA'],
  ['#3B6D11', '#EAF3DE']
];

export const getColor = (idx) => PALETTE[idx % PALETTE.length];

export const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export const escapeHtml = (text) => {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
};

export const exportToCSV = (data, filename) => {
  if (!data.length) return alert('Nenhum dado para exportar');
  const keys = Object.keys(data[0]);
  const csv = [
    keys.join(','),
    ...data.map(row =>
      keys.map(k => {
        let val = row[k];
        if (typeof val === 'object') val = val.toDate?.() || new Date(0);
        if (val instanceof Date) val = val.toLocaleDateString('pt-BR') + ' ' + val.toLocaleTimeString('pt-BR');
        return `"${String(val || '').replace(/"/g, '""')}"`;
      }).join(',')
    )
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.setAttribute('href', URL.createObjectURL(blob));
  link.setAttribute('download', `${filename}-${today()}.csv`);
  link.click();
};
