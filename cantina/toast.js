// Sistema de notificações aprimorado

export class Toast {
  constructor(containerId = 'toasts') {
    this.container = document.getElementById(containerId);
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.id = containerId;
      this.container.className = 'toast-container';
      document.body.appendChild(this.container);
    }
  }

  // Toast de sucesso
  success(message, duration = 3500) {
    return this._show(message, 'success', duration, '✓');
  }

  // Toast de erro
  error(message, duration = 4500) {
    return this._show(message, 'error', duration, '✕');
  }

  // Toast de aviso
  warning(message, duration = 3500) {
    return this._show(message, 'warning', duration, '⚠');
  }

  // Toast de informação
  info(message, duration = 3500) {
    return this._show(message, 'info', duration, 'ℹ');
  }

  // Toast de carregamento (não desaparece automaticamente)
  loading(message) {
    const id = this._show(message, 'loading', 0, '⏳');
    return { id, close: () => this._removeById(id) };
  }

  // Mostrar toast
  _show(message, type, duration, icon) {
    const id = 'toast-' + Date.now() + Math.random();
    const toast = document.createElement('div');
    toast.id = id;
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<i>${icon}</i><span>${message}</span>`;

    this.container.appendChild(toast);

    // Animar entrada
    setTimeout(() => toast.classList.add('show'), 10);

    // Auto-remover
    if (duration > 0) {
      setTimeout(() => this._removeById(id), duration);
    }

    return id;
  }

  _removeById(id) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }
  }

  clearAll() {
    this.container.innerHTML = '';
  }
}
