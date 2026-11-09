const { read } = require('node:fs');
const { promisify } = require('node:util');
const { setTimeout: pause } = require('node:timers/promises');

const readAsync = promisify(read);
const RETRYABLE = new Set(['EAGAIN', 'EWOULDBLOCK', 'EINTR']);
const DISCONNECTED = new Set(['EBADF', 'ENXIO', 'UNKNOWN']);
let modbusBinding;

function cancelledRead() {
  return Object.assign(new Error('Serial read cancelled: port is closed'), { canceled: true });
}

// The serialport binding option is per port. Keep native open/close/write and
// replace only Darwin's recursive empty-read path; never patch fs or globals.
function createDarwinModbusBinding(nativeBinding, { read = readAsync, wait = pause } = {}) {
  return {
    list: (...args) => nativeBinding.list(...args),
    async open(options) {
      const port = await nativeBinding.open(options);
      port.read = async (buffer, offset, length) => {
        if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer must be a Buffer');
        if (!Number.isInteger(offset) || !Number.isInteger(length)
          || offset < 0 || length < 0 || offset + length > buffer.length) {
          throw new RangeError('Invalid serial read range');
        }
        const fd = port.fd;
        const current = () => port.isOpen && port.fd === fd;
        while (current()) {
          try {
            const result = await read(fd, buffer, offset, length, null);
            if (!current()) throw cancelledRead();
            if (result.bytesRead > 0 || length === 0) return result;
          } catch (error) {
            if (!current()) throw cancelledRead();
            if (!RETRYABLE.has(error.code)) {
              if (DISCONNECTED.has(error.code) || error.errno === -1) error.disconnect = true;
              throw error;
            }
          }
          // VMIN=0 is required by existing macOS PTY communication. Empty
          // nonblocking reads must yield, rather than create an unbounded
          // promise chain at ~100,000 reads/sec. Retry interval: 2 ms.
          await wait(2);
        }
        throw cancelledRead();
      };
      return port;
    },
  };
}

function getDarwinModbusBinding() {
  modbusBinding ??= createDarwinModbusBinding(require('serialport').SerialPort.binding);
  return modbusBinding;
}

module.exports = { createDarwinModbusBinding, getDarwinModbusBinding };
