export const LOG_LEVEL_OPTIONS = Object.freeze(['debug', 'info', 'warn', 'error']);

export function formatLogLevel(level) {
  switch (level) {
    case 'debug': return 'DEBUG 调试';
    case 'info': return 'INFO 信息';
    case 'warn':
    case 'warning': return 'WARN 警告';
    case 'error': return 'ERROR 错误';
    default: return String(level);
  }
}
